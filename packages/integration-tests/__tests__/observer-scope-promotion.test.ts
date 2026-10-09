// A "use" collaborator is verified only against the connections their scope reaches. Merging an
// agent-proposed binding, binding on mainline, or enabling a hook on an unbound connection widens
// that scope, so the workspace restarts and the viewer's next open re-verifies against it. The
// user's own binding edits (bind, rename, unbind) also reload the running gadget's environment.

import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AiChatMessage, AuthenticatedApi, Overseer } from "@gadgets/workshop-shared/api";
import { openAgentSession } from "../src/agent-session.js";
import {
  settleRestart, startTestGatekeeperHarness, TEST_VENDOR_ID, testControl, type Harness,
} from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter, type RoutedScriptedModel } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, logIn, MAX_OBSERVER_PROMPTS, nextUsernames,
  ObserverConfigRecorder, signUp, stubFor, waitFor, waitForIdleChat, withOwnerWorkspace,
  type ConnectedAccount, type RpcTarget,
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

async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(a => a.vendorId === TEST_VENDOR_ID) ?? null;
  });
}

// A fresh owner with a provisioned test account and a new workspace.
async function newWorkspace(usernamePrefix: string) {
  const [username] = nextUsernames(usernamePrefix);
  using stack = new DisposableStack();
  const api = stack.use(await signUp(stack.use(connect(harness.url)), username));
  const account = await provisionAccount(api);
  const ws = stack.use(await api.newGadget());
  return Object.assign(stack.move(), { account, ws });
}

async function newConnection(ws: RpcStub<Overseer>, accountId: number, resourceUrl: string) {
  using connection = await ws.newGatekeeper(accountId, resourceUrl);
  if (!connection) throw new Error(`Failed to create the connection to ${resourceUrl}`);
  return await connection.getId();
}

const openSession = (model: RoutedScriptedModel, usernamePrefix: string) =>
  openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: model.userModel,
    ambientVendorIds: [TEST_VENDOR_ID],
    usernamePrefix,
  });

function connectionCard(history: AiChatMessage[]) {
  const card = history.find(message => message.type === "connectionRequest");
  if (!card) throw new Error("The agent did not create a connection request");
  return card;
}

// A viewer's session on its own connection. The default recorder has no queued responses, so an
// open that needs verification throws.
async function holdSession(
    workspaceId: string, who: string, recorder = new ObserverConfigRecorder()) {
  using stack = new DisposableStack();
  const api = await logIn(stack.use(connect(harness.url)), who);
  using callback = stubFor(recorder);
  const overseer = stack.use(await api.openGadget(workspaceId, undefined, callback));
  return Object.assign(stack.move(), { overseer });
}

type Viewer = { name: string; account: ConnectedAccount };

async function addViewer(ws: RpcStub<Overseer>): Promise<Viewer> {
  const [name] = nextUsernames("viewer");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, name);
  const account = await provisionAccount(api);
  if (!await ws.addCollaborator(name, "use")) throw new Error(`Failed to share with ${name}`);
  return { name, account };
}

// A fresh recorder per attempt, so a failed attempt can't consume a later attempt's responses.
const reopenVerified = (workspaceId: string, viewer: Viewer) =>
  waitFor("the viewer to reopen after the restart", async () => {
    const recorder = new ObserverConfigRecorder()
        .alwaysChoose(viewer.account.id, MAX_OBSERVER_PROMPTS);
    try {
      return Object.assign(await holdSession(workspaceId, viewer.name, recorder), { recorder });
    } catch {
      return null;
    }
  });

it("merging an agent-proposed binding re-verifies a live use viewer against it", async () => {
  const SOURCE_URL = "https://gadgets-test.example/things/promotion-source";
  // The workspace isn't listed until its first chat, and a chat's seed env is frozen at its first
  // activation, so the agent creates APP itself. An unbound connection isn't in the chat's env,
  // so the agent reaches it only by request.
  const model = models.script([
    { toolCall: { id: "create", name: "createGadget", arguments: { title: "App", bindingName: "APP" } } },
    { text: "Created." },
    {
      toolCall: {
        id: "request",
        name: "requestConnection",
        arguments: {
          vendorId: TEST_VENDOR_ID,
          resourceUrl: SOURCE_URL,
          reason: "Read the source value.",
          bindingName: "SOURCE",
        },
      },
    },
    {
      toolCall: {
        id: "bind",
        name: "setGadgetBinding",
        arguments: { gadget: "APP", source: "SOURCE", name: "DATA" },
      },
    },
    { text: "Bound." },
  ]);
  await using session = await openSession(model, "promotionowner");

  const created = await session.runTurn("Create APP.");
  expect(created.outcome).toEqual({ status: "completed" });
  await session.acceptChanges();
  const appId = created.workpieces.find(w => w.title === "App")?.id;
  if (appId === undefined) throw new Error("The agent did not create APP");

  const { sourceId, workspaceId, viewer } =
      await withOwnerWorkspace(harness.url, session.username, async ws => {
    return {
      sourceId: await newConnection(ws, session.connectedAccount(TEST_VENDOR_ID).id, SOURCE_URL),
      workspaceId: (await ws.getMetadata()).id,
      viewer: await addViewer(ws),
    };
  });

  using held = await holdSession(workspaceId, viewer.name);

  const requested = await session.runTurn("Bind the source into APP.");
  expect(requested.outcome).toEqual({ status: "completed" });
  const card = connectionCard(requested.history);

  await withOwnerWorkspace(harness.url, session.username, async ws => {
    await ws.acceptConnectionRequest(card.requestId, { gatekeeperId: sourceId });
    await waitForIdleChat(ws, card.chatId);
    expect(model.remainingSteps()).toBe(0);

    using app = await ws.getGadget(appId);
    expect((await app.listBindings()).map(b => b.name)).not.toContain("DATA");
    expect(await app.listBindings(card.chatId)).toContainEqual(
        expect.objectContaining({ name: "DATA", target: sourceId, chatId: card.chatId }));

    // A pending edge widens nothing: no connection is blocked and no restart lands.
    using _usable = await ws.getGatekeeperById(sourceId);
    await settleRestart();
    await expect(held.overseer.getMetadata()).resolves.toMatchObject({ id: workspaceId });
    expect(await ws.mergeChanges(card.chatId)).toEqual({ outcome: "merged" });
    await expect(ws.getGatekeeperById(sourceId)).rejects.toThrow(/restarting/);
  });

  await waitFor("the viewer's session to be severed", () =>
    held.overseer.getMetadata().then(() => null, () => true));
  using reopened = await reopenVerified(workspaceId, viewer);
  expect(reopened.recorder.callCount).toBe(1);
  expect(reopened.recorder.calls[0].map(n => n.gatekeeperId)).toEqual([sourceId]);
});

interface StateGadget extends RpcTarget {
  deliveredValue(): Promise<number | null>;
}

// Unlike workshop-hooks' HOOK_SERVER, this writes the gadget's own state: a bound source would
// already put the connection in use scope, and enabling the hook would prove nothing.
const STATE_HOOK_SERVER = `import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async [restore](params) {
    if (params.type !== "state-hook") throw new TypeError("Unknown restore type: " + params.type);
    return new StateHook(this.ctx.storage);
  }
  async deliveredValue() { return (await this.ctx.storage.get("value")) ?? null; }
}
class StateHook extends RpcTarget {
  constructor(storage) { super(); this.storage = storage; }
  async onValueRequested(value) { await this.storage.put("value", value); }
}`;

it("enabling a hook on an unbound connection re-verifies a live use viewer and delivers to their gadget",
    async () => {
  const [hookKey] = nextUsernames("hookscope");
  const SOURCE_URL = "https://gadgets-test.example/things/hook-source";
  const watchCode = `import { restore } from "cloudflare:workers";
export default async function(self, env) {
  await env.SOURCE.watch(${JSON.stringify(hookKey)}, await env.HOOKED[restore]({ type: "state-hook" }));
}`;
  const model = models.script([
    {
      toolCalls: [
        { id: "create", name: "createGadget", arguments: { title: "Hooked", bindingName: "HOOKED" } },
        {
          id: "write",
          name: "writeFile",
          arguments: { workpiece: "HOOKED", filename: "server.js", content: STATE_HOOK_SERVER },
        },
      ],
    },
    { text: "Built." },
    {
      toolCall: {
        id: "request",
        name: "requestConnection",
        arguments: {
          vendorId: TEST_VENDOR_ID,
          resourceUrl: SOURCE_URL,
          reason: "Watch the source value.",
          bindingName: "SOURCE",
        },
      },
    },
    { toolCall: { id: "watch", name: "executeCode", arguments: { code: watchCode } } },
    { text: "Watching." },
  ]);
  await using session = await openSession(model, "hookscopeowner");

  expect((await session.runTurn("Build the hooked gadget.")).outcome).toEqual({ status: "completed" });
  await session.acceptChanges();

  const { sourceId, workspaceId } = await withOwnerWorkspace(harness.url, session.username, async ws => {
    const sourceId = await newConnection(ws, session.connectedAccount(TEST_VENDOR_ID).id, SOURCE_URL);
    return { sourceId, workspaceId: (await ws.getMetadata()).id };
  });

  const watchTurn = await session.runTurn("Watch the source.");
  expect(watchTurn.outcome).toEqual({ status: "completed" });
  const card = connectionCard(watchTurn.history);

  const { hook, viewer } = await withOwnerWorkspace(harness.url, session.username, async ws => {
    await ws.acceptConnectionRequest(card.requestId, { gatekeeperId: sourceId });
    await waitForIdleChat(ws, card.chatId);
    expect(model.remainingSteps()).toBe(0);

    const listed = (await ws.listHooks()).find(h => h.description.title === `Test hook ${hookKey}`);
    if (!listed) throw new Error(`No hook listed for ${hookKey}`);
    expect(listed).toMatchObject({ gatekeeperId: sourceId, enabled: false });
    using gadget = await ws.getGadget(listed.gadgetId);
    expect((await gadget.listBindings()).some(b => b.target === sourceId)).toBe(false);
    return { hook: listed, viewer: await addViewer(ws) };
  });

  using held = await holdSession(workspaceId, viewer.name);
  await withOwnerWorkspace(harness.url, session.username, ws => ws.enableHook(hook.id));

  await waitFor("the viewer's session to be severed", () =>
    held.overseer.getMetadata().then(() => null, () => true));
  using reopened = await reopenVerified(workspaceId, viewer);
  expect(reopened.recorder.callCount).toBe(1);
  expect(reopened.recorder.calls[0].map(n => n.gatekeeperId)).toEqual([sourceId]);
  expect(await testControl(harness, "observer-events", { resourceUrl: SOURCE_URL }))
      .toEqual({ events: [expect.objectContaining({ type: "add" })] });

  using gadget = await reopened.overseer.getGadget(hook.gadgetId);
  using facet = await gadget.connectToGadget() as RpcStub<StateGadget>;
  expect(await testControl(harness, "fire-hook", { key: hookKey, value: 7 })).toEqual({ fired: true });
  expect(await facet.deliveredValue()).toBe(7);
});

interface EnvironmentGadget extends RpcTarget {
  envKeys(): Promise<string[]>;
}

const ENVIRONMENT_SERVER = `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async envKeys() { return Object.keys(this.env).sort(); }
}`;

it("mainline binding edits reload the running gadget's environment", async () => {
  const model = models.script([
    {
      toolCalls: [
        { id: "create", name: "createGadget", arguments: { title: "Environment", bindingName: "ENVIRONMENT" } },
        {
          id: "write",
          name: "writeFile",
          arguments: { workpiece: "ENVIRONMENT", filename: "server.js", content: ENVIRONMENT_SERVER },
        },
      ],
    },
    { text: "Built." },
  ]);
  await using session = await openSession(model, "bindingenv");
  const built = await session.runTurn("Build the environment gadget.");
  expect(built.outcome).toEqual({ status: "completed" });
  await session.acceptChanges();
  const gadgetId = built.workpieces.find(w => w.title === "Environment")?.id;
  if (gadgetId === undefined) throw new Error("The agent did not create the gadget");

  await withOwnerWorkspace(harness.url, session.username, async ws => {
    const accountId = session.connectedAccount(TEST_VENDOR_ID).id;
    const firstId = await newConnection(ws, accountId, "https://gadgets-test.example/things/env-first");
    const suggestedId =
        await newConnection(ws, accountId, "https://gadgets-test.example/things/env-suggested");
    using app = await ws.getGadget(gadgetId);
    // A fresh facet per check, so each one runs against the environment the last edit left.
    const envKeys = async () => {
      using facet = await app.connectToGadget() as RpcStub<EnvironmentGadget>;
      return await facet.envKeys();
    };

    await app.bind("DATA", firstId);
    expect(await envKeys()).toEqual(["DATA", "GADGET", "GIT"]);
    await expect(app.bind("DATA", suggestedId)).rejects.toThrow('There is already a binding named "DATA".');

    expect(await app.bindWithSuggestedName(suggestedId)).toBe("TEST_THING");
    expect(await envKeys()).toEqual(["DATA", "GADGET", "GIT", "TEST_THING"]);

    const annotation = {
      title: "Suggested test thing",
      description: "Keep this annotation through a rename.",
      suggestValue: true,
    };
    await app.setBlueprintAnnotation("TEST_THING", annotation);
    await app.renameBinding("TEST_THING", "RENAMED");
    expect(await app.getBlueprintAnnotation("RENAMED")).toEqual(annotation);
    expect(await envKeys()).toEqual(["DATA", "GADGET", "GIT", "RENAMED"]);

    await app.unbind("RENAMED");
    expect(await envKeys()).toEqual(["DATA", "GADGET", "GIT"]);
  });
});

it("mainline binding names steer clear of another chat's pending binding", async () => {
  using owner = await newWorkspace("bindingconflict");
  const { account, ws } = owner;
  using app = await ws.createGadget("App", undefined, "APP");
  const draftTargetId =
      await newConnection(ws, account.id, "https://gadgets-test.example/things/draft-name");
  const mainlineTargetId =
      await newConnection(ws, account.id, "https://gadgets-test.example/things/mainline-name");

  const chatB = await ws.newChat("Reserve TEST_THING", null);
  await app.bind("TEST_THING", draftTargetId, chatB);
  expect(await app.listBindings()).not.toContainEqual(expect.objectContaining({ name: "TEST_THING" }));
  expect(await app.listBindings(chatB)).toContainEqual(
      expect.objectContaining({ name: "TEST_THING", target: draftTargetId, chatId: chatB }));

  await expect(app.bind("TEST_THING", mainlineTargetId)).rejects.toThrow(
      'The binding name "TEST_THING" is already proposed by another chat. ' +
      "Accept or revert that chat's changes first, or choose a different name.");
  expect(await app.bindWithSuggestedName(mainlineTargetId)).toBe("TEST_THING_2");

  await app.bind("MAIN", mainlineTargetId);
  await expect(app.renameBinding("MAIN", "TEST_THING"))
      .rejects.toThrow('There is already a binding named "TEST_THING".');
});

it("a mainline bind re-verifies a held use viewer against the bound connection", async () => {
  using owner = await newWorkspace("bindingviewer");
  const { account, ws } = owner;
  using app = await ws.createGadget("App", undefined, "APP");
  const sourceId =
      await newConnection(ws, account.id, "https://gadgets-test.example/things/live-binding");
  const workspaceId = (await ws.getMetadata()).id;
  const viewer = await addViewer(ws);
  // Unbound, the connection is outside the viewer's use scope, so this open needs no verification.
  using held = await holdSession(workspaceId, viewer.name);

  await app.bind("DATA", sourceId);
  await expect(ws.getGatekeeperById(sourceId)).rejects.toThrow(/restarting/);

  await waitFor("the viewer's session to be severed", () =>
    held.overseer.getMetadata().then(() => null, () => true));
  using reopened = await reopenVerified(workspaceId, viewer);
  expect(reopened.recorder.callCount).toBe(1);
  expect(reopened.recorder.calls[0].map(n => n.gatekeeperId)).toEqual([sourceId]);
});
