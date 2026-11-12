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
    "delivers permission alerts only when enabled (spawned: $spawned, enabled: $enabled)",
    async ({ spawned, enabled }) => {
  const model = models.script([{ toolCall: { id: "ask", name: "executeCode", arguments: {
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
  await waitFor("a persisted pending permission request", async () =>
    (await ws.listActions({ filter: "pending" })).entries.length === 1 ? true : null);
  if (enabled) await waitFor("the permission alert", async () => received.events.length === 1 ? true : null);
  else await new Promise(resolve => setTimeout(resolve, 200));
  expect(received.events).toEqual(enabled ? [expect.objectContaining({ chatId, kind: "permissionRequested" })] : []);
  expect((await api.getWorkspaceUnreadState(workspaceId)).find(chat => chat.chatId === chatId))
    .toMatchObject({ notificationsEnabled: enabled, unreadMessageCount: 0 });
  expect(model.remainingSteps()).toBe(0);
});
