import { afterAll, beforeAll, expect, it } from "vitest";
import { workspaceLogoUrl } from "@gadgets/workshop-shared/api";
import { startHarness, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, waitFor, waitForIdleChat } from "../src/rpc-client.js";

let harness: Harness;
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });

beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [] });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

it("chat 0's model draws a workspace one logo, served from its listing until it is deleted",
    async () => {
  const model = models.script([{ text: "Hello." }, { text: "Again." }]);
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, nextUsernames("logo")[0]!);
  await api.addModel(model.userModel.profile, model.userModel.config);
  using ws = await api.newGadget();
  const { id } = await ws.getMetadata();

  const chatId = await ws.newChat("A tracker for my sourdough starter", SCRIPTED_MODEL_ID);
  await waitForIdleChat(ws, chatId);
  const listed = await waitFor("the workspace's logo in its listing", async () =>
    (await api.listGadgets()).find(gadget => gadget.id === id && gadget.logo !== undefined) ?? null);
  const url = workspaceLogoUrl(listed);
  if (url === undefined) throw new Error("A listed logo has no URL");

  const response = await fetch(new URL(url, harness.url));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/svg+xml");
  expect(await response.text()).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    "<style>@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }</style>" +
    '<circle cx="32" cy="32" r="24" fill="#f60"/></svg>');

  // Later chat 0 turns don't draw (or pay for) another.
  await ws.sendChatMessage(chatId, "And another thing", SCRIPTED_MODEL_ID);
  await waitFor("the second reply", async () => model.remainingSteps() === 0 || null);
  await waitForIdleChat(ws, chatId);
  const logoRequests = model.auxiliaryRequests.filter(request => request.kind === "workspace-logo");
  expect(logoRequests).toHaveLength(1);
  expect(JSON.stringify(logoRequests[0]?.body)).toContain("A tracker for my sourdough starter");

  await ws.deleteSelf();
  expect((await fetch(new URL(url, harness.url))).status).toBe(404);
});
