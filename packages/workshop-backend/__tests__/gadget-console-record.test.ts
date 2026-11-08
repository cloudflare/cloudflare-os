// What a deployment that records gadget console output keeps of an exception a gadget method
// throws at its caller. The facet proxy of getGadgetFacet() catches it, delivers it to live
// subscribers and hands it to GadgetConsoleLogLoopback, which writes its line. The rest of a
// gadget's server output is recorded by its tail worker, which reads the Worker's own env: that
// carries no switch in this pool, so the integration suite covers it.
//
// Runs a real gadget, loaded from a real commit, inside a real OverseerDurableObject.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { ConsoleLogEvent } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const GADGET_ID = 1;

const SERVER_JS = `
import { DurableObject } from "cloudflare:workers";

export class Gadget extends DurableObject {
  greet(name) {
    return name;
  }

  fail() {
    throw new Error("boom");
  }
}
`;

// One log a live subscriber was sent, with the chat its event named.
type Received = { chatId: number | null; level: ConsoleLogEvent["level"]; message: unknown[] };

let doCounter = 0;

// Runs `fn` in an Overseer of its own that holds the gadget and has one live subscriber, whose
// logs are `received`.
async function withGadget(fn: (impl: any, received: Received[]) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`gadget-console-record-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let commitId = await impl.gitCache.writeFilesAsCommit(new Map([["server.js", SERVER_JS]]), {
      parents: [],
      author: { name: "Alice", email: "alice@example.com" },
      message: "test commit",
      timestamp: new Date(1700000000_000),
    });
    impl.storage.gadgets.put({
      type: "gadget", id: GADGET_ID, title: "G", created: new Date(0), bindingName: "G",
      bindings: {}, commitId,
    });

    // Keeps each log it is sent, so the empty batch every request's tail delivers adds nothing.
    // (onRpcBroken must exist on the recorder: a native stub over a plain object forwards it.)
    let received: Received[] = [];
    using recorder = new NativeRpcStub({
      event: async (chatId: number | null, logs: ConsoleLogEvent[]) => {
        for (let { level, message } of logs) received.push({ chatId, level, message });
      },
      onRpcBroken: () => {},
    });
    using _subscription = await impl.subscribeToConsoleLogs(recorder);
    await fn(impl, received);
  });
}

// Sets the deployment's switch for this Overseer alone.
function setRecording(impl: any, value: string): void {
  impl.env = { ...impl.env, RECORD_GADGET_CONSOLE_LOGS: value };
}

// Calls `method` of the gadget on a stub of its own, under `chatId` when given, and expects the
// call to reject with `error`. The call is wrapped in a function: a call on a getGadgetFacet()
// stub is a native RPC promise, which is callable, and `rejects` calls a callable it is given and
// waits for what that returns, which would leave the call itself rejected with no handler.
async function rejects(impl: any, method: string, error: RegExp, chatId?: number): Promise<void> {
  using gadget = await impl.getGadgetFacet(GADGET_ID, chatId);
  await expect(() => gadget[method]()).rejects.toThrow(error);
}

// Calls the gadget's fail(), which throws "boom" at its caller.
const fail = (impl: any, chatId?: number) => rejects(impl, "fail", /boom/, chatId);

// `impl.ctx` standing in front of the real one, with `loopback` where the Overseer mints its
// GadgetConsoleLogLoopback. Every function it hands out is bound to the real ctx.
function replaceGadgetConsoleLogLoopback(impl: any, loopback: unknown): void {
  let real = impl.ctx;
  let exports = { ...real.exports, GadgetConsoleLogLoopback: loopback };
  impl.ctx = new Proxy(real, {
    get(target, name) {
      if (name === "exports") return exports;
      let value = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

let info: MockInstance<typeof console.info>;
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The `gadget.console` lines written so far, in order.
const lines = (): Record<string, unknown>[] =>
  info.mock.calls.map(([line]) => line).filter(line => line?.component === "gadget.console");

// The line an exception of the gadget's server is written as, with no chat and no user.
const errorLine = (impl: any, text: unknown) => ({
  component: "gadget.console", event: "gadget.console.entry", message: "gadget console entry",
  gadgetId: impl.ctx.id.toString(), workpieceId: GADGET_ID, consoleSource: "server",
  consoleLevel: "error", time: expect.any(String), text,
});

// What the facet proxy makes of the error fail() throws.
const BOOM = expect.stringMatching(/boom\n {4}at fail\(\)$/);

describe("recording an exception a gadget method throws at its caller", () => {
  it.each([
    ["a workspace", (_impl: any) => {}],
    // The flag changes nothing: a restricted workspace's output is recorded like any other's.
    ["a workspace that holds restricted data",
      (impl: any) => impl.storage.containsRestrictedData.put(true)],
  ])("writes one line for %s, and still delivers the event", (_name, prepare) =>
      withGadget(async (impl, received) => {
    setRecording(impl, "true");
    prepare(impl);

    await fail(impl);

    await vi.waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()).toStrictEqual([errorLine(impl, BOOM)]);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received).toStrictEqual([{ chatId: null, level: "error", message: [BOOM] }]);
  }));

  // The proxy answers every method name and puts the name in its event, so a line's
  // consoleSource says where it was produced and not who chose its text, as
  // GadgetConsoleLogEntry.source's doc and docs/gadget-console-logs.md state. A change that
  // stops this case passing means those two statements need another look.
  it("writes a line whose text the caller chose as the server's, under no user", () =>
      withGadget(async (impl, received) => {
    setRecording(impl, "true");

    await rejects(impl, "noSuchMethod_zzq", /noSuchMethod_zzq/);

    await vi.waitFor(() => expect(lines()).toHaveLength(1));
    let [line] = lines();
    expect(line).toStrictEqual(errorLine(impl, expect.any(String)));
    expect(line.text).toContain('does not implement the method "noSuchMethod_zzq"');
    expect(line.text).toMatch(/at noSuchMethod_zzq\(\)$/);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received).toStrictEqual([{ chatId: null, level: "error", message: [line.text] }]);
  }));

  // "false" stands beside the unset variable because the Overseer has to ask
  // isGadgetConsoleLogRecordingEnabled(): a site that read the variable's truthiness instead
  // would record under "false", and pass with the unset variable alone.
  it.each([
    ["unset", (_impl: any) => {}],
    ['"false"', (impl: any) => setRecording(impl, "false")],
  ])("writes nothing while the variable is %s", (_name, turnOff) =>
      withGadget(async (impl, received) => {
    turnOff(impl);

    await fail(impl);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received).toStrictEqual([{ chatId: null, level: "error", message: [BOOM] }]);

    // An exception is recorded after its call has returned, so a line the first call wrongly
    // wrote could still be on its way. A second call, recorded, is waited for instead: its line
    // has a text of its own, and was handed to its writer after the first call's would have been.
    setRecording(impl, "true");
    await rejects(impl, "sentinel_zzq", /sentinel_zzq/);
    await vi.waitFor(() => expect(lines().at(-1)?.text).toMatch(/at sentinel_zzq\(\)$/));
    expect(lines()).toHaveLength(1);
  }));

  // Each half pins one way of getting the chat wrong. A record made with the caller's chat as
  // given fails the first, since it would put an idle chat's id on a mainline error. One made
  // with no chat fails the second, since it would file a draft's error under the mainline. What
  // decides is #resolveGadgetChatId, for which a chat counts only if it exists, so it is seeded.
  it("names the chat whose code ran, while the live event keeps the chat the caller named", () =>
      withGadget(async (impl, received) => {
    setRecording(impl, "true");
    impl.storage.chatMeta.put(
        { id: 7, title: "Chat", started: new Date(0), lastActive: new Date(0) });

    // The chat proposes nothing, so the mainline runs.
    await fail(impl, 7);
    await vi.waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toStrictEqual(errorLine(impl, BOOM));
    await vi.waitFor(() => expect(received).toHaveLength(1));

    // The chat proposes a change to the gadget, so the gadget is loaded under it: with the
    // mainline's files, since the chat pins nothing.
    impl.proposedChangeWorkpieceIds = () => [GADGET_ID];
    await fail(impl, 7);
    await vi.waitFor(() => expect(lines()).toHaveLength(2));
    expect(lines()[1]).toStrictEqual({ ...errorLine(impl, BOOM), chatId: 7 });
    await vi.waitFor(() => expect(received).toHaveLength(2));

    expect(received).toStrictEqual([
      { chatId: 7, level: "error", message: [BOOM] },
      { chatId: 7, level: "error", message: [BOOM] },
    ]);
  }));

  it.each([
    ["rejects", () => ({ server: async () => { throw new Error("down"); } }), /down/],
    ["throws", () => ({ server: () => { throw new Error("down"); } }), /down/],
    ["cannot be minted", () => { throw new Error("no entrypoint"); }, /no entrypoint/],
  ])("gives the caller the gadget's own error when the writer %s", (_name, loopback, failure) =>
      withGadget(async (impl, received) => {
    setRecording(impl, "true");
    replaceGadgetConsoleLogLoopback(impl, loopback);

    // The gadget's error, which holds "boom": the writer's holds neither that nor the method.
    await fail(impl);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received).toStrictEqual([{ chatId: null, level: "error", message: [BOOM] }]);

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      component: "workshop.overseer", event: "gadget.console.record.failed",
      message: "failed to record a gadget exception", gadgetId: impl.ctx.id.toString(),
      error: expect.stringMatching(failure),
    })));
    expect(lines()).toHaveLength(0);
  }));
});
