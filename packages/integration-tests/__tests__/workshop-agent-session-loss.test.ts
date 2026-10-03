// The Workshop aborts an API session on purpose when it loses its workspace DO, expecting the
// client to reconnect while the DO resumes the interrupted turn (server.ts #openGadgetInternal,
// overseer.ts #resumeInterruptedAgents, main.tsx reconnect()). The agent session must do the same,
// or a turn the product completed is reported as a failure after the whole turn budget has passed.
import { createServer, connect as connectTcp, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openAgentSession } from "../src/agent-session.js";
import { startTestGatekeeperHarness, type Harness } from "../src/harness.js";
import {
  scriptedChatCompletions, SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID, SCRIPTED_MODEL_PROFILE,
} from "../src/mock-model.js";
import { NetworkInterceptor, type Handler } from "../src/network-interceptor.js";

/** A TCP relay in front of the harness whose live connections the test can cut. */
type Relay = { url: URL; cut(): void; close(): Promise<void> };

function startRelay(target: URL): Promise<Relay> {
  const sockets = new Set<Socket>();
  const server: Server = createServer(downstream => {
    const upstream = connectTcp({ host: target.hostname, port: Number(target.port) });
    sockets.add(downstream).add(upstream);
    downstream.pipe(upstream).pipe(downstream);
    const drop = () => {
      sockets.delete(downstream);
      sockets.delete(upstream);
      downstream.destroy();
      upstream.destroy();
    };
    downstream.on("close", drop).on("error", drop);
    upstream.on("close", drop).on("error", drop);
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("relay has no port");
    resolve({
      url: new URL(`http://127.0.0.1:${address.port}`),
      cut: () => { for (const socket of sockets) socket.destroy(); },
      close: () => new Promise(done => server.close(() => done())),
    });
  }));
}

let harness: Harness;
let serverClosed = false;
const model = scriptedChatCompletions([{ text: "Done." }, { pending: true }]);
// The first model request is held until the test releases it, so the break can land mid-turn.
const modelRequestArrived = Promise.withResolvers<void>();
const releaseModel = Promise.withResolvers<void>();
const gatedModel: Handler = async (url, method, headers, request) => {
  if (method === "POST" && url.pathname.endsWith("/chat/completions")) {
    modelRequestArrived.resolve();
    await releaseModel.promise;
  }
  return model.handler(url, method, headers, request);
};
const network = new NetworkInterceptor({ handlers: [gatedModel] });

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

it("reconnects when the session breaks mid-turn and reports what the agent did", async () => {
  const relay = await startRelay(harness.url);
  try {
    await using session = await openAgentSession(relay.url, {
      modelId: SCRIPTED_MODEL_ID,
      userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
    });
    const turn = session.runTurn("Say done.", { timeoutMs: 60_000 });
    await modelRequestArrived.promise;

    relay.cut();
    releaseModel.resolve();

    const result = await turn;
    expect(result.outcome).toEqual({ status: "completed" });
    expect(result.history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "message", author: expect.objectContaining({ type: "agent" }), message: "Done.",
      }),
    ]));
  } finally {
    await relay.close();
  }
});

it("fails the active turn once the session cannot be re-established", async () => {
  const session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
  });
  const turn = session.runTurn("Start a model request that never resolves.", {
    timeoutMs: 120_000,
  });
  turn.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 500));

  serverClosed = true;
  await harness.server.close();

  await expect(turn).rejects.toThrow("RPC session broken");
  expect(() => session.runTurn("Do not run this turn.")).toThrow("cannot continue");
  await expect(session.close()).resolves.toBeUndefined();
}, 90_000);
