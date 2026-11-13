import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { NotificationSubscriber, UserNotification } from "@gadgets/workshop-shared/api";
import { openAgentSession } from "../src/agent-session.js";
import { startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, RpcTarget, stubFor, waitFor, waitForIdleChat } from "../src/rpc-client.js";

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

class Notifications extends RpcTarget implements NotificationSubscriber {
  readonly events: UserNotification[] = [];
  async notify(event: UserNotification) { this.events.push(event); }
}
interface Probe extends RpcTarget { run(): Promise<void>; }
interface Spawner extends RpcTarget {
  spawnCallable(title: string, options: { types: string; mainType: string }): Promise<Probe>;
}

it.each([false, true].flatMap(spawned => [false, true].map(enabled => ({ spawned, enabled }))))(
    "preserves catch-up history and delivers enabled alerts (spawned: $spawned, enabled: $enabled)",
    async ({ spawned, enabled }) => {
  const model = models.script([{text: "A message to catch up on."}, { toolCall: { id: "ask", name: "executeCode", arguments: {
    code: "export default async function(self, env) { await env.TEST_AMBIENT.writeValue(7); }",
  } } }]);
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: model.userModel,
    ambientVendorIds: [TEST_VENDOR_ID],
    usernamePrefix: "chatmute",
  });
  using publicApi = connect(harness.url);
  using api = await logIn(publicApi, session.username);
  using ws = await api.newWorkspace();
  const { id: workspaceId } = await ws.getMetadata();
  const received = new Notifications();
  using subscriber = stubFor(received);
  using _subscription = await api.subscribeToNotifications(subscriber);
  let chatId: number;
  using stubs = new DisposableStack();
  let start: () => Promise<unknown>;
  if (spawned) {
    const connection = stubs.use(await ws.newGatekeeper(session.connectedAccount(TEST_VENDOR_ID).id,
      "https://gadgets-test.example/things/notifications"));
    if (!connection) throw new Error("Test connection was not created");
    const spawner = stubs.use(await ws.newAgentSpawnerGatekeeper({
      displayName: "Probe", modelId: SCRIPTED_MODEL_ID,
      env: { TEST_AMBIENT: await connection.getId() },
    }));
    const binding = stubs.use(await spawner.openSession() as RpcStub<Spawner>);
    const callable = stubs.use(await binding.spawnCallable("Permission probe", {
      types: "interface Probe { /** Ask for a test write. */ run(): void; }", mainType: "Probe",
    }) as RpcStub<Probe>);
    chatId = (await ws.listChats())[0]!.id;
    start = () => callable.run();
  } else {
    chatId = await ws.newChat("Permission probe", null);
    start = () => ws.sendChatMessage(chatId, "Ask for a test write.", SCRIPTED_MODEL_ID);
  }
  const defaultEnabled = !spawned;
  if (enabled !== defaultEnabled) await ws.setChatNotificationsEnabled(chatId, enabled);
  await start();
  await waitForIdleChat(ws, chatId);
  if (enabled) await waitFor("the completion alert", async () => received.events.length === 1 ? true : null);
  const state = (await api.getWorkspaceUnreadState(workspaceId)).find(chat => chat.chatId === chatId)!;
  expect(state).toMatchObject({notificationsEnabled: enabled, unreadMessageCount: 1});
  expect((await api.getUnreadSummary()).unreadMessageCount).toBe(enabled ? 1 : 0);
  await ws.setChatNotificationsEnabled(chatId, !enabled);
  await ws.setChatNotificationsEnabled(chatId, enabled);
  expect((await api.getWorkspaceUnreadState(workspaceId)).find(chat => chat.chatId === chatId))
    .toEqual({...state, notificationsEnabledOverride: enabled});
  // The backend's unread-state tests prove muted suppression and no replay against the outbox.
  // Public RPC exposes no delivery-drained signal, so an empty callback list here would not prove
  // that a muted alert cannot arrive later. Keep delivery assertions positive at this layer.
  if (enabled) expect(received.events).toEqual([expect.objectContaining({chatId, kind: "taskCompleted"})]);
  // A normal reading receipt still catches up a muted chat without enabling its badges or alerts.
  await ws.markChatRead(chatId);
  received.events.length = 0;
  await start();
  await waitForIdleChat(ws, chatId);
  await waitFor("a persisted pending permission request", async () =>
    (await ws.listActions({ filter: "pending" })).entries.length === 1 ? true : null);
  if (enabled) {
    await waitFor("the permission alert", async () => received.events.length === 1 ? true : null);
    expect(received.events).toEqual([expect.objectContaining({ chatId, kind: "permissionRequested" })]);
  }
  expect((await api.getWorkspaceUnreadState(workspaceId)).find(chat => chat.chatId === chatId))
    .toMatchObject({ notificationsEnabled: enabled, unreadMessageCount: 0 });
  expect(model.remainingSteps()).toBe(0);
});

it("notifies a spawned chat's approval before participation without enabling completion alerts or its inbox entry", async () => {
  const model = models.script([{toolCall: {id: "ask", name: "executeCode", arguments: {
    code: "export default async function(self, env) { await env.TEST_AMBIENT.writeValue(7); }",
  }}}, {text: "Approved write completed."}]);
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID, userModel: model.userModel,
    ambientVendorIds: [TEST_VENDOR_ID], usernamePrefix: "defaultapproval",
  });
  using publicApi = connect(harness.url);
  using api = await logIn(publicApi, session.username);
  using ws = await api.newWorkspace();
  const {id: workspaceId} = await ws.getMetadata();
  const received = new Notifications();
  using subscriber = stubFor(received);
  using _subscription = await api.subscribeToNotifications(subscriber);
  using connection = await ws.newGatekeeper(session.connectedAccount(TEST_VENDOR_ID).id,
    "https://gadgets-test.example/things/defaultapproval");
  if (!connection) throw new Error("Test connection was not created");
  using spawner = await ws.newAgentSpawnerGatekeeper({displayName: "Approval", modelId: SCRIPTED_MODEL_ID,
    env: {TEST_AMBIENT: await connection.getId()}});
  using binding = await spawner.openSession() as RpcStub<Spawner>;
  using callable = await binding.spawnCallable("Unattended approval", {
    types: "interface Probe { run(): void; }", mainType: "Probe",
  }) as RpcStub<Probe>;
  const chatId = (await ws.listChats())[0]!.id;
  await callable.run();
  await waitForIdleChat(ws, chatId);
  const pending = await waitFor("the blocked approval", async () =>
    (await ws.listActions({filter: "pending"})).entries[0] ?? null);
  await waitFor("the default-off approval alert", async () => received.events.length === 1 ? true : null);
  expect(received.events).toEqual([expect.objectContaining({chatId, kind: "permissionRequested"})]);
  expect((await api.getWorkspaceUnreadState(workspaceId)).find(chat => chat.chatId === chatId))
    .toMatchObject({notificationsEnabled: false});
  expect(await api.getUnreadThreads()).toEqual([]);
  expect((await api.getUnreadSummary()).unreadMessageCount).toBe(0);
  await ws.approveAction(pending.id);
  await waitForIdleChat(ws, chatId);
  expect((await ws.listActions({filter: "pending"})).entries).toEqual([]);
  expect((await api.getWorkspaceUnreadState(workspaceId)).find(chat => chat.chatId === chatId))
    .toMatchObject({notificationsEnabled: false, unreadMessageCount: 1});
  expect(await api.getUnreadThreads()).toEqual([]);
  expect(model.remainingSteps()).toBe(0);
});

it("opts into a spawned chat on first human participation and preserves a later explicit mute", async () => {
  const model = models.script([{text: "Automated result."}, {text: "First human reply."}, {text: "Muted reply."}]);
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID, userModel: model.userModel, usernamePrefix: "participation",
  });
  using publicApi = connect(harness.url);
  using api = await logIn(publicApi, session.username);
  using ws = await api.newWorkspace();
  const {id: workspaceId} = await ws.getMetadata();
  const received = new Notifications();
  using subscriber = stubFor(received);
  using _subscription = await api.subscribeToNotifications(subscriber);
  using spawner = await ws.newAgentSpawnerGatekeeper({displayName: "Participation", modelId: SCRIPTED_MODEL_ID, env: {}});
  using binding = await spawner.openSession() as RpcStub<Spawner>;
  using callable = await binding.spawnCallable("Automated chat", {
    types: "interface Probe { run(): void; }", mainType: "Probe",
  }) as RpcStub<Probe>;
  const chatId = (await ws.listChats())[0]!.id;
  await callable.run();
  await waitForIdleChat(ws, chatId);
  const initial = (await api.getWorkspaceUnreadState(workspaceId)).find(chat => chat.chatId === chatId)!;
  expect(initial).toMatchObject({notificationsEnabled: false, unreadMessageCount: 1});
  expect(await api.getUnreadThreads()).toEqual([]);

  await ws.sendChatMessage(chatId, "I want to participate", SCRIPTED_MODEL_ID);
  await waitForIdleChat(ws, chatId);
  await waitFor("the first participating completion alert", async () => received.events.length === 1 ? true : null);
  const followed = (await api.getWorkspaceUnreadState(workspaceId)).find(chat => chat.chatId === chatId)!;
  expect(followed).toMatchObject({notificationsEnabled: true, unreadMessageCount: 3,
    readThroughSequence: initial.readThroughSequence});
  expect(await api.getUnreadThreads()).toMatchObject([{chatId, unreadMessageCount: 3}]);

  await ws.setChatNotificationsEnabled(chatId, false);
  await ws.sendChatMessage(chatId, "Keep this muted", SCRIPTED_MODEL_ID);
  await waitForIdleChat(ws, chatId);
  const muted = (await api.getWorkspaceUnreadState(workspaceId)).find(chat => chat.chatId === chatId)!;
  expect(muted).toMatchObject({notificationsEnabled: false, unreadMessageCount: 5,
    readThroughSequence: initial.readThroughSequence});
  expect(await api.getUnreadThreads()).toEqual([]);
  await ws.setChatNotificationsEnabled(chatId, true);
  expect(await api.getUnreadThreads()).toMatchObject([{chatId, unreadMessageCount: 5,
    readThroughSequence: initial.readThroughSequence}]);
  expect(model.remainingSteps()).toBe(0);
});
