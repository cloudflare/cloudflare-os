import { afterAll, beforeAll, expect, it } from "vitest";
import { openAgentSession } from "../src/agent-session.js";
import { startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

let harness: Harness;
const models = scriptedModelRouter();
// No web handler: a fetch that got past the gate would be recorded as unmocked.
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

const TARGET = "https://gadgets-test.example/restricted-web-fetch";
const REFUSED = "This workspace has observed sensitive data. To prevent leaks, the workspace is " +
    "prohibited from fetching from public web sites.";

it("refuses a web fetch once the workspace has read restricted data", async () => {
  const model = models.script([
    { toolCall: { id: "read-restricted", name: "executeCode", arguments: {
      code: "export default async function(self, env) { " +
          "console.log(await env.TEST_AMBIENT.readValue(true)); }",
    } } },
    { toolCall: { id: "fetch-page", name: "webFetch", arguments: { url: TARGET } } },
    { text: "The page could not be fetched." },
  ]);
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: model.userModel,
    ambientVendorIds: [TEST_VENDOR_ID],
    usernamePrefix: "restrictedfetch",
  });
  const turn = await session.runTurn("Read the restricted value, then fetch the page.");

  expect(turn.outcome).toEqual({ status: "completed" });
  expect(model.requests).toHaveLength(3);
  expect(model.requests[2]).toMatchObject({ messages: expect.arrayContaining([
    expect.objectContaining(
        { role: "tool", tool_call_id: "fetch-page", content: expect.stringContaining(REFUSED) }),
  ]) });
  expect(network.getUnmockedCalls()).toEqual([]);
});
