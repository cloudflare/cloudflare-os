import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import { loadAllChatHistory, openAgentSession } from "../src/agent-session.js";
import { startTestGatekeeperHarness, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  restartWorkspace, RpcTarget, streamGeneration, stubFor, waitFor, waitForIdleChat,
  withOwnerWorkspace, WorkpieceRecorder,
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
interface Caller extends RpcTarget {
  dispatch(document: string): Promise<void>;
}

const CALLER_SERVER = `import { DurableObject } from "cloudflare:workers";
const TYPES = "interface TaskAgent {\\n  /** Process one document, in arrival order. */\\n  process(document: string): void;\\n}";
export class Gadget extends DurableObject {
  async dispatch(document) {
    this.agent ??= await this.env.SPAWNER.spawnCallable("Callable task", { types: TYPES, mainType: "TaskAgent" });
    await this.agent.process(document);
  }
}
`;

it.concurrent("callable-agent calls land in order across a workspace restart", async () => {
  const model = models.script([
    { toolCalls: [
      { id: "create-caller", name: "createGadget",
        arguments: { title: "Caller", bindingName: "CALLER" } },
      { id: "write-caller", name: "writeFile",
        arguments: { workpiece: "CALLER", filename: "server.js", content: CALLER_SERVER } },
    ] },
    { text: "Built." },
    { pending: true },
    { text: "first handled" },
    { text: "second handled" },
  ]);
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: model.userModel,
    usernamePrefix: "callableagents",
  });

  expect((await session.runTurn("Build the caller.")).outcome).toEqual({ status: "completed" });
  await session.acceptChanges();

  let spawnedId!: number;
  const before = await withOwnerWorkspace(harness.url, session.username, async ws => {
    {
      const workpieces = new WorkpieceRecorder();
      using workpiecesStub = stubFor(workpieces);
      using _workpieces = await ws.subscribeToWorkpieces(workpiecesStub);
      await workpieces.loaded;
      const callerSummary = [...workpieces.summaries.values()]
          .find(summary => summary.type === "gadget" && summary.title === "Caller");
      if (callerSummary === undefined) throw new Error("The Caller gadget was not created");

      using spawner = await ws.newAgentSpawnerGatekeeper({
        displayName: "Callable dispatcher",
        modelId: SCRIPTED_MODEL_ID,
        env: {},
      });
      using gadget = await ws.getGadget(callerSummary.id);
      await gadget.bind("SPAWNER", await spawner.getId());
      using caller = await gadget.connectToGadget() as RpcStub<Caller>;

      await caller.dispatch("first");
      const spawned = await waitFor("the callable agent's first turn", async () => {
        const chat = (await ws.listChats()).find(({ spawnerName }) => spawnerName === "Callable dispatcher");
        return model.requests.length === 3 && chat?.activeAgent !== undefined ? chat : null;
      });
      spawnedId = spawned.id;
      const firstHistory = await loadAllChatHistory(
          beforeSequence => ws.getChatHistory(spawnedId, beforeSequence));
      expect(firstHistory.filter(message => message.type === "agentCallback")).toHaveLength(1);

      await caller.dispatch("second");
      const queuedHistory = await loadAllChatHistory(
          beforeSequence => ws.getChatHistory(spawnedId, beforeSequence));
      expect(queuedHistory.filter(message => message.type === "agentCallback")).toHaveLength(1);
    }

    const generation = await streamGeneration(ws);
    await restartWorkspace(harness.url, ws);
    return generation;
  });
  await waitFor("the workspace restart", async () => session.connectionDrops > 0 ? true : null);

  await withOwnerWorkspace(harness.url, session.username, async ws => {
    await waitFor("both callable-agent turns", async () => model.requests.length === 5 || null);
    await waitForIdleChat(ws, spawnedId);

    expect(await streamGeneration(ws)).not.toBe(before);
    expect(model.requests[3]).toEqual(model.requests[2]);

    const history = await loadAllChatHistory(
        beforeSequence => ws.getChatHistory(spawnedId, beforeSequence));
    const callbacks = history.filter(message => message.type === "agentCallback");
    expect(callbacks).toMatchObject([
      { methodName: "process", argsSummary: expect.stringContaining("first") },
      { methodName: "process", argsSummary: expect.stringContaining("second") },
    ]);
    expect(callbacks[1]!.sequence).toBeGreaterThan(callbacks[0]!.sequence);
    for (const text of ["first handled", "second handled"]) {
      expect(history.filter(message => message.type === "message" &&
        message.author.type === "agent" && message.message === text)).toHaveLength(1);
    }
    expect(model.remainingSteps()).toBe(0);
  });
});
