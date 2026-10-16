// Gmail and Chat hooks enabled under the release before this one, carried across the upgrade to
// this tree's gatekeeper-google with all of its Durable Object storage, as a deployment upgrades:
// the real Workshop and both real builds, with only Google faked (google-fake.ts). The release
// before is main as it was before the hook delivery queue moved into gatekeeper-kit, built by
// `build:upgrade-base`, and the upgrade is wrangler's storage-preserving `update()`, the one
// Harness.redeployWorkshop() uses.
//
// The queue's rows, attempt counts included, are read back by gatekeeper-kit's own test of the
// rows the old queue wrote. What only a real upgrade shows is the rest: that the capabilities the
// drivers stored, their alarms, the Gmail watch and history cursor and the Chat subscription all
// carry over, and that a delivery the old release was making when it was replaced resumes.

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuthenticatedApi, Overseer } from "@gadgets/workshop-shared/api";
import { startHarness, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, nextUsernames, signUp, waitFor, waitForIdleChat } from "../src/rpc-client.js";
import { FakeGoogle, baseGoogleGatekeeper, upgradeGoogle } from "./google-fake.js";

const google = new FakeGoogle();
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler, google.handler] });
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [baseGoogleGatekeeper()], enableGadgetExecution: true });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

/** A gadget whose hooks take every message, failing for a Chat message that says to. */
const HOOKED_SERVER = `import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async [restore](params) {
    if (params.type !== "gmail" && params.type !== "chat") throw new TypeError("Unknown restore type: " + params.type);
    return new Inbox();
  }
}
class Inbox extends RpcTarget {
  async receiveMessage({ info }) {
    if (info.text?.includes("fail")) throw new Error("Not now.");
  }
}`;

const SUBSCRIBE = `import { restore } from "cloudflare:workers";
export default async function(self, env) {
  await env.GMAIL.subscribeNewMessages(await env.HOOKED[restore]({ type: "gmail" }));
  await env.CHAT.subscribeNewMessages(await env.HOOKED[restore]({ type: "chat" }));
}`;

/**
 * A workspace whose HOOKED gadget is bound to the inbox as GMAIL and to `space` as CHAT, with a
 * hook subscribed on each, built and subscribed through chat turns as the agent would.
 */
async function subscribedWorkspace(api: RpcStub<AuthenticatedApi>, accountId: number, space: string) {
  const model = models.script([
    { toolCall: { id: "server", name: "writeFile", arguments: {
      workpiece: "HOOKED", filename: "server.js", content: HOOKED_SERVER,
    } } },
    { text: "Built." },
    { toolCall: { id: "subscribe", name: "executeCode", arguments: { code: SUBSCRIBE } } },
    { text: "Subscribed." },
  ]);
  await api.addModel(model.userModel.profile, model.userModel.config);
  const ws = await api.newGadget();
  using gmail = await ws.newGatekeeper(accountId, "https://mail.google.com/mail/");
  using chat = await ws.newGatekeeper(accountId, `https://chat.google.com/room/${space.slice("spaces/".length)}`);
  if (!gmail || !chat) throw new Error("Failed to connect Gmail and Chat");
  using hooked = await ws.createGadget("Hooked", undefined, "HOOKED");
  // Bound before the chat opens: a permanent edge seeds a new chat's env under its name.
  await hooked.bind("GMAIL", await gmail.getId());
  await hooked.bind("CHAT", await chat.getId());
  const chatId = await ws.newChat("Build the hooks.", SCRIPTED_MODEL_ID);
  await waitFor("the build turn", async () => model.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);
  expect((await ws.mergeChanges(chatId)).outcome).toBe("merged");
  await ws.sendChatMessage(chatId, "Subscribe them.", SCRIPTED_MODEL_ID);
  await waitFor("the subscribe turn", async () => model.requests.length === 4 || null);
  await waitForIdleChat(ws, chatId);
  expect(model.remainingSteps()).toBe(0);
  const hooks = await ws.listHooks();
  const hookTitled = (title: string) => {
    const hook = hooks.find(candidate => candidate.description.title === title);
    if (!hook) throw new Error(`No hook "${title}" among ${JSON.stringify(hooks)}`);
    return hook.id;
  };
  return {
    ws,
    workspaceId: (await ws.getMetadata()).id,
    gmailHook: hookTitled("Watch for new Gmail messages"),
    chatHook: hookTitled("Watch for new Google Chat messages"),
  };
}

/** What each hook has been handed, oldest first: the subject of each Gmail message, the sender of each Chat one. */
async function delivered(ws: RpcStub<Overseer>) {
  const { entries } = await ws.listActions({ filter: "observation" });
  const oldestFirst = entries.toSorted((a, b) => a.id - b.id);
  return {
    gmail: oldestFirst.flatMap(entry => /^New Gmail message: (.*)$/.exec(entry.description.title)?.slice(1) ?? []),
    chat: oldestFirst.filter(entry => entry.description.title === "Receive a new Google Chat message")
      .flatMap(entry => / from (Person \d+) /.exec(entry.description.description)?.slice(1) ?? []),
  };
}

/** Long enough for a delivery the gatekeeper wrongly starts to reach the workspace. */
const settle = () => new Promise(resolve => setTimeout(resolve, 1_000));

it("carries Gmail and Chat hooks, their deliveries and their Google state across the upgrade", async () => {
  using stack = new DisposableStack();
  const [username] = nextUsernames("googleupgrade");
  const mailbox = FakeGoogle.mailboxOf(username!);
  const space = `spaces/AAQA${username}`;

  // ── Under the release before this one ──────────────────────────────────────────────────────
  const before = stack.use(await signUp(stack.use(connect(harness.url)), username!));
  const account = await google.connect(harness, before, username!);
  const { ws: wsBefore, workspaceId, gmailHook, chatHook } = await subscribedWorkspace(before, account.id, space);
  stack.use(wsBefore);
  await wsBefore.enableHook(gmailHook);
  await wsBefore.enableHook(chatHook);
  const [subscription] = google.subscriptions.keys();

  // A message delivered on each, which the queue then remembers as finished.
  google.arrive(mailbox, "First");
  expect(await google.pushGmail(harness, mailbox)).toBe(204);
  const first = google.chatMessage(space, 1);
  expect(await google.pushChat(harness, subscription!, first)).toBe(204);
  await waitFor("the first messages to be delivered", async () => {
    const { gmail, chat } = await delivered(wsBefore);
    return gmail.includes("First") && chat.includes("Person 1") || null;
  });

  // A Chat message the hook fails on, whose retry disabling the hook then cancels.
  const failing = google.chatMessage(space, 2, "fail on this");
  expect(await google.pushChat(harness, subscription!, failing)).toBe(204);
  await waitFor("the failing message to be tried", async () => (await delivered(wsBefore)).chat.includes("Person 2") || null);
  await wsBefore.disableHook(chatHook);

  // A Gmail message the old release is delivering when it is replaced.
  const second = google.arrive(mailbox, "Second");
  const cursor = google.historyId(mailbox);
  const inFlight = google.hold(second);
  expect(await google.pushGmail(harness, mailbox)).toBe(204);
  await waitFor("the delivery to be in flight", async () => inFlight.started || null);

  // ── The upgrade ─────────────────────────────────────────────────────────────────────────────
  await upgradeGoogle(harness);
  // Every read of the message waited for this, so the old release, gone now, never had an
  // answer: what delivers it is this tree's build.
  inFlight.release();

  // ── Under this tree's release ───────────────────────────────────────────────────────────────
  const api = stack.use(await logIn(stack.use(connect(harness.url)), username!));
  const ws = stack.use(await api.openGadget(workspaceId));

  // The delivery the upgrade cut off resumes, from the alarm the old release left set.
  await waitFor("the cut-off delivery to resume", async () => (await delivered(ws)).gmail.includes("Second") || null);

  // New mail is read from where the old release's history cursor stopped, under its watch.
  google.arrive(mailbox, "Third");
  expect(await google.pushGmail(harness, mailbox)).toBe(204);
  await waitFor("new mail to be delivered", async () => (await delivered(ws)).gmail.includes("Third") || null);
  expect(google.historyReads.at(-1)).toBe(cursor);

  // The Chat hook disabled before the upgrade is still disabled, so a redelivery reaches no one.
  expect((await ws.listHooks()).find(hook => hook.id === chatHook)).toMatchObject({ enabled: false });
  expect(await google.pushChat(harness, subscription!, first)).toBe(204);
  // Enabled again, it is not handed again what it finished before the upgrade, delivered or
  // cancelled, but is handed what is new, through the subscription the old release made.
  await ws.enableHook(chatHook);
  expect(await google.pushChat(harness, subscription!, first)).toBe(204);
  expect(await google.pushChat(harness, subscription!, failing)).toBe(204);
  expect(await google.pushChat(harness, subscription!, google.chatMessage(space, 3))).toBe(204);
  await waitFor("the new Chat message to be delivered", async () => (await delivered(ws)).chat.includes("Person 3") || null);
  await settle();
  expect(await delivered(ws)).toEqual({
    gmail: ["First", "Second", "Third"], chat: ["Person 1", "Person 2", "Person 3"],
  });
  // Neither the watch nor the subscription was made again.
  expect(google.requests.filter(request => request === "POST gmail.googleapis.com/gmail/v1/users/me/watch")).toHaveLength(1);
  expect(google.requests.filter(request => request === "POST workspaceevents.googleapis.com/v1/subscriptions")).toHaveLength(1);

  // Disconnecting the account drops its hooks, the Gmail one included, though the old release
  // never told the account of it: the mailbox's driver did at its first alarm after the upgrade.
  // A hook left behind would have its driver read the history of a mailbox it no longer can.
  await api.disconnectAccount(account.id);
  expect(google.revokedTokens).toEqual([`refresh-${username}`]);
  harness.server.clearLogs();
  google.arrive(mailbox, "After");
  expect(await google.pushGmail(harness, mailbox)).toBe(204);
  await settle();
  expect(harness.server.getLogs().filter(log => log.message.includes("gmail.hooks."))).toEqual([]);
  expect((await delivered(ws)).gmail).not.toContain("After");
});
