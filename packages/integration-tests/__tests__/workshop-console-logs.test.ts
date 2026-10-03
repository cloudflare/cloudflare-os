import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type {
  ConsoleLogEvent, ConsoleLogSubscriber, GadgetClient, Overseer, WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { startTestGatekeeperHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, nextUsernames, RpcTarget, signUp, stubFor, waitFor, WorkpieceRecorder,
} from "../src/rpc-client.js";

const network = new NetworkInterceptor();
let harness: Harness;

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

type Log = { chatId: number | null; level: ConsoleLogEvent["level"]; message: unknown[] };

class LogRecorder extends RpcTarget implements ConsoleLogSubscriber {
  readonly logs: Log[] = [];
  async event(chatId: number | null, logs: ConsoleLogEvent[]) {
    this.logs.push(...logs.map(({ level, message }) => ({ chatId, level, message })));
  }
  /** Wait for the log of the call that greeted `name`. */
  logged(name: string) {
    return waitFor(`the log greeting ${name}`, async () =>
      this.logs.find(log => log.message[1] === name) ?? null);
  }
}

const server = (label: string, level: "log" | "warn") =>
  `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  greet(name) { console.${level}("${label}", name); return name; }
}
`;
const MAINLINE = server("mainline", "log");

const files = (gadgetId: WorkpieceId, text?: string): CodeContent =>
  new Map([[gadgetId, new Map(text === undefined ? [] : [["server.js", text]])]]);

type Owner = {
  ws: RpcStub<Overseer>;
  gadget: RpcStub<GadgetClient>;
  gadgetId: WorkpieceId;
  head: string;
};

/** Sign up an owner whose workspace has gadget `APP` with the `MAINLINE` server merged. */
async function withLoggingGadget<T>(fn: (owner: Owner) => Promise<T>): Promise<T> {
  const [username] = nextUsernames("logowner");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, username!);
  using ws = await api.newGadget();
  const workpieces = new WorkpieceRecorder();
  using workpiecesStub = stubFor(workpieces);
  using _workpieces = await ws.subscribeToWorkpieces(workpiecesStub);
  await workpieces.loaded;
  using gadget = await ws.createGadget("App", undefined, "APP");
  const gadgetId = await gadget.getId();
  const headOf = (after?: string) => waitFor(`a new head for gadget ${gadgetId}`, async () => {
    const summary = workpieces.summaries.get(gadgetId);
    return summary?.type === "gadget" && summary.commitId !== undefined &&
        summary.commitId !== after ? summary.commitId : null;
  });
  const empty = await headOf();
  const seed = await ws.newChat("Seed", null);
  await ws.submitCodeChange(seed, {
    generation: 0, revision: 0, clientId: "seed", seq: 1, pins: [{ gadgetId, baseCommit: empty }],
    change: diffFiles(files(gadgetId), files(gadgetId, MAINLINE)),
  });
  expect(await ws.mergeChanges(seed)).toEqual({ outcome: "merged" });
  return await fn({ ws, gadget, gadgetId, head: await headOf(empty) });
}

/** Call the gadget's server, as the mainline or `chatId`'s draft. */
async function greet(gadget: RpcStub<GadgetClient>, name: string, chatId?: number) {
  using facet = await gadget.connectToGadget(chatId) as RpcStub<{ greet(name: string): string }>;
  expect(await facet.greet(name)).toBe(name);
}

it.concurrent("gadget console logs reach subscribers, labelled with their draft or mainline",
    async () => {
  await withLoggingGadget(async ({ ws, gadget, gadgetId, head }) => {
    const draft = await ws.newChat("Draft", null);
    await ws.submitCodeChange(draft, {
      generation: 0, revision: 0, clientId: "draft", seq: 1, pins: [{ gadgetId, baseCommit: head }],
      change: diffFiles(files(gadgetId, MAINLINE), files(gadgetId, server("draft", "warn"))),
    });
    await ws.finalizeChatDraft(draft);
    const recorder = new LogRecorder();
    using recorderStub = stubFor(recorder);
    using _logs = await ws.subscribeToConsoleLogs(recorderStub);

    await greet(gadget, "Ada", draft);
    await greet(gadget, "Grace");
    expect(await recorder.logged("Ada"))
        .toEqual({ chatId: draft, level: "warn", message: ["draft", "Ada"] });
    expect(await recorder.logged("Grace"))
        .toEqual({ chatId: null, level: "log", message: ["mainline", "Grace"] });
  });
});

it.concurrent("disposing a console log subscription stops its logs but not others'", async () => {
  await withLoggingGadget(async ({ ws, gadget }) => {
    const stopped = new LogRecorder();
    const live = new LogRecorder();
    using stoppedStub = stubFor(stopped);
    using liveStub = stubFor(live);
    const subscription = await ws.subscribeToConsoleLogs(stoppedStub);
    using _live = await ws.subscribeToConsoleLogs(liveStub);
    await greet(gadget, "before");
    await Promise.all([stopped.logged("before"), live.logged("before")]);

    subscription[Symbol.dispose]();
    await greet(gadget, "after");
    await live.logged("after");
    // Both subscriptions share one connection, so a log sent to the stopped one is here by now.
    expect(stopped.logs.map(log => log.message[1])).toEqual(["before"]);
  });
});

it.concurrent("a use collaborator's console log subscription receives nothing", async () => {
  await withLoggingGadget(async ({ ws, gadget }) => {
    const [viewer] = nextUsernames("logviewer");
    using viewerPublic = connect(harness.url);
    using viewerApi = await signUp(viewerPublic, viewer!);
    if (!await ws.addCollaborator(viewer!, "use")) {
      throw new Error(`Failed to share with ${viewer}`);
    }
    using useWs = await viewerApi.openGadget((await ws.getMetadata()).id);
    const viewerLogs = new LogRecorder();
    const ownerLogs = new LogRecorder();
    using viewerStub = stubFor(viewerLogs);
    using ownerStub = stubFor(ownerLogs);
    using _viewer = await useWs.subscribeToConsoleLogs(viewerStub);
    using _owner = await ws.subscribeToConsoleLogs(ownerStub);

    await greet(gadget, "Ada");
    await ownerLogs.logged("Ada");
    // Anything already sent to the viewer's connection arrives before this reply.
    await useWs.getMetadata();
    expect(viewerLogs.logs).toEqual([]);
  });
});
