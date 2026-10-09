// Providers cache a prompt by its prefix: a request reads the cache only as far as it matches an
// earlier request byte for byte. So each request a chat sends must start with the whole of the
// request before it, or everything after the first difference is paid for again.

import { z } from "zod";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openAgentSession } from "../src/agent-session.js";
import { startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

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

// A chat completions request: its messages, and the fields that shape how the provider renders
// them (tools, model, reasoning options).
const REQUEST = z.looseObject({ messages: z.array(z.unknown()) });

// Compares serialized JSON, so a reordered key counts as a difference, as it does for the cache.
function expectEachRequestExtendsThePrevious(requests: readonly unknown[]) {
  const parsed = requests.map(request => REQUEST.parse(request));
  for (const [index, { messages, ...fields }] of parsed.entries()) {
    const previous = parsed[index - 1];
    if (previous === undefined) continue;
    const { messages: previousMessages, ...previousFields } = previous;
    expect(JSON.stringify(fields), `fields of request ${index}`)
        .toBe(JSON.stringify(previousFields));
    expect(messages.slice(0, previousMessages.length).map(m => JSON.stringify(m)),
        `messages of request ${index}`).toEqual(previousMessages.map(m => JSON.stringify(m)));
  }
}

const READ_TEST_VALUE =
    "export default async function(self, env) { console.log(await env.TEST_AMBIENT.readValue()); }";

it.concurrent("each request starts with the whole request before it", async () => {
  const model = models.script([
    { toolCall: { id: "read-value", name: "executeCode", arguments: { code: READ_TEST_VALUE } } },
    { text: "The test value is 42." },
    { text: "It is still 42." },
  ]);
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: model.userModel,
    ambientVendorIds: [TEST_VENDOR_ID],
  });

  expect((await session.runTurn("Read the test value.")).outcome).toEqual({ status: "completed" });
  expect((await session.runTurn("Is it the same now?")).outcome).toEqual({ status: "completed" });
  expect(model.requests).toHaveLength(3);
  expectEachRequestExtendsThePrevious(model.requests);
});
