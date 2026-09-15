// The Workshop aborts an API session on purpose when it loses its workspace DO, expecting the
// client to reconnect. A session that only observes chat events would otherwise wait out the whole
// turn budget on the dead socket; the first eval run lost 28 minutes to exactly that.
import { afterAll, beforeAll, expect, it } from "vitest";
import { openAgentSession } from "../src/agent-session.js";
import { startTestGatekeeperHarness, type Harness } from "../src/harness.js";
import {
  scriptedChatCompletions, SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID, SCRIPTED_MODEL_PROFILE,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { waitFor } from "../src/rpc-client.js";

let harness: Harness;
let serverClosed = false;
const model = scriptedChatCompletions([{ pending: true }]);
const network = new NetworkInterceptor({ handlers: [model.handler] });

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness({ enableGadgetExecution: true });
});

afterAll(async () => {
  try {
    if (!serverClosed) await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

it("fails the active turn as soon as the RPC session breaks", async () => {
  const session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
  });
  const turn = session.runTurn("Start a model request that never resolves.", {
    timeoutMs: 60_000,
  });
  turn.catch(() => {});
  await waitFor("the pending model request", () =>
    Promise.resolve(model.requests.length === 1 ? true : null));

  const startedAt = Date.now();
  serverClosed = true;
  await harness.server.close();

  await expect(turn).rejects.toThrow("RPC session broken");
  expect(Date.now() - startedAt).toBeLessThan(20_000);
  expect(() => session.runTurn("Do not run this turn.")).toThrow("cannot continue");
  await expect(session.close()).resolves.toBeUndefined();
});
