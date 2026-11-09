// What a deployment that records gadget console output keeps of an exception a gadget method
// throws at its caller. The facet proxy of getGadgetFacet() catches it, delivers it to live
// subscribers and hands it to GadgetConsoleLogLoopback, which writes its line. The rest of a
// gadget's server output is recorded by its tail worker, which reads the Worker's own env: the
// tail the runtime runs gets this pool's, which carries no switch, so the integration suite
// covers that one, and the last cases here call tail() on an entrypoint made with an env of their
// own, for the values no harness is started with.
//
// Runs a real gadget, loaded from a real commit, inside a real OverseerDurableObject.
//
// And what it keeps of the console output a session reports for a gadget's UI. The session checks
// the gadget and the chat, the Overseer applies the per-call cap and the gadget's limit, and
// GadgetConsoleLogLoopback writes the batch. Those cases open the real OverseerClientInterface as
// the workspace's owner. A use session's reports are in use-gadget-access.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  MAX_GADGET_CONSOLE_LOGS_PER_CALL, MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH,
  type AiChatAuthorInfo, type ConsoleLogEvent, type Overseer, type ReportedGadgetConsoleLog,
} from "@gadgets/workshop-shared/api";
import { GADGET_CONSOLE_LOGS_PER_MINUTE, gadgetConsoleLogText } from "../src/gadget-console-log.js";
import { GadgetTailLoopback, type OverseerDurableObject } from "../src/overseer.js";

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

  failWithObject() {
    throw { code: 42 };
  }

  failWithBytes() {
    throw new Uint8Array(1_000_000);
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

// The `gadget.console` markers written so far, in order.
const markers = (): Record<string, unknown>[] =>
  warn.mock.calls.map(([line]) => line).filter(line => line?.component === "gadget.console");

// The line an exception of the gadget's server is written as, with no chat and no user.
const errorLine = (impl: any, text: unknown) => ({
  component: "gadget.console", event: "gadget.console.entry", message: "gadget console entry",
  gadgetId: impl.ctx.id.toString(), workpieceId: GADGET_ID, consoleSource: "server",
  consoleLevel: "error", time: expect.any(String), text,
});

// What the facet proxy makes of the error fail() throws.
const BOOM = expect.stringMatching(/boom\n {4}at fail\(\)$/);

// Filler of `n` characters in which no run of token characters is long.
const words = (n: number) => "word ".repeat(Math.ceil(n / 5)).slice(0, n);

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

  // The gadget and its caller decide how long an error's text is, and the proxy's event holds a
  // called name twice, so a name of some seventeen million characters makes an event too large
  // for the call to the writer to carry. Cut to what is read, it makes the line the whole event
  // would. (The written line would show nothing here: the writer cuts whatever it is handed.)
  it("hands its writer no more of an exception's text than is read", () =>
      withGadget(async (impl, received) => {
    setRecording(impl, "true");
    let handed: unknown[][] = [];
    replaceGadgetConsoleLogLoopback(
        impl, () => ({ server: async (...args: unknown[]) => { handed.push(args); } }));

    let name = words(100_000);
    await rejects(impl, name, /does not implement the method/);

    await vi.waitFor(() => expect(handed).toHaveLength(1));
    let [event] = handed[0][2] as ConsoleLogEvent[];
    expect(event.message).toHaveLength(1);
    expect(event.message[0]).toHaveLength(MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH);

    // A live subscriber is sent the event whole.
    await vi.waitFor(() => expect(received).toHaveLength(1));
    let [whole] = received[0].message as string[];
    expect(whole.length).toBeGreaterThan(2 * name.length);
    expect(gadgetConsoleLogText(event.message)).toBe(gadgetConsoleLogText([whole]));
  }));

  // A thrown value that is no Error reaches the proxy as the value, with members the runtime adds
  // after its own. It is recorded as any console argument is: as JSON.
  it("records a thrown value that is no Error as JSON", () =>
      withGadget(async (impl, received) => {
    setRecording(impl, "true");

    using gadget = await impl.getGadgetFacet(GADGET_ID);
    await expect(() => gadget.failWithObject()).rejects.toMatchObject({ code: 42 });

    await vi.waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()).toStrictEqual([errorLine(impl, expect.stringMatching(/^\{"code":42[,}]/))]);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received).toStrictEqual(
        [{ chatId: null, level: "error", message: [expect.objectContaining({ code: 42 })] }]);
  }));

  // The gadget decides how large a value it throws, and the JSON of one is many times its size:
  // some eleven characters for each of these bytes. The writer is handed the text that is read of
  // the value, and neither the value nor the whole of its JSON.
  it("hands its writer no more of a thrown value that is no Error than is read", () =>
      withGadget(async (impl, received) => {
    setRecording(impl, "true");
    let handed: unknown[][] = [];
    replaceGadgetConsoleLogLoopback(
        impl, () => ({ server: async (...args: unknown[]) => { handed.push(args); } }));

    using gadget = await impl.getGadgetFacet(GADGET_ID);
    await expect(() => gadget.failWithBytes()).rejects.toHaveLength(1_000_000);

    await vi.waitFor(() => expect(handed).toHaveLength(1));
    let [event] = handed[0][2] as ConsoleLogEvent[];
    expect(event.message).toStrictEqual([
      JSON.stringify(new Uint8Array(MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH))
          .slice(0, MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH),
    ]);

    // A live subscriber is sent the value whole.
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].message).toHaveLength(1);
    expect(received[0].message[0]).toHaveLength(1_000_000);
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

const OWNER_USER_ID = "owner-user-do";
const OWNER: AiChatAuthorInfo = { type: "user", id: "olive@example.com", name: "Olive" };

// A second gadget of the workspace, and a worktree.
const OTHER_GADGET_ID = 2;
const WORKTREE_ID = 3;

// Opens the real OverseerClientInterface as the owner over an Overseer of its own, with the
// owner's user DO faked. The workspace holds two gadgets and a worktree, and records gadget
// console output unless `recording` says otherwise: null leaves the variable unset, as the pool
// gives it.
async function withSession(
    fn: (impl: any, client: Overseer) => Promise<void>,
    recording: string | null = "true"): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`gadget-console-record-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = OWNER_USER_ID;
    impl.ensureAmbientCapsules = async () => {};
    impl.markOutputsDirty = () => {};
    impl.startAgent = () => {};
    let owner = {
      id: OWNER_USER_ID,
      whoami: async () => OWNER,
      getChatContext: async () => ({ profile: OWNER }),
      setWorkspaceLastActive: async () => {},
    };
    impl.users = { idFromString: (id: string) => id, get: () => owner };
    for (let id of [GADGET_ID, OTHER_GADGET_ID]) {
      impl.storage.gadgets.put({
        type: "gadget", id, title: `Gadget ${id}`, created: new Date(0), bindingName: `G${id}`,
        bindings: {},
      });
    }
    impl.storage.gadgets.put({
      type: "worktree", id: WORKTREE_ID, title: "Repo", created: new Date(0), chatId: 0,
      baseCommit: "c0", headCommit: "c0", pinBase: "c0",
    });
    if (recording !== null) setRecording(impl, recording);

    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    using client = await instance.open(OWNER_USER_ID, OWNER.id, notifyClosed);
    await fn(impl, client);
  });
}

// When the reported calls of the cases that fake no clock were made.
const AT = new Date("2026-01-02T03:04:05.678Z");

// One reported call, made at `AT`.
const reported = (text: string, level: ConsoleLogEvent["level"] = "log")
    : ReportedGadgetConsoleLog => ({ time: AT, level, text });

// `count` reported calls made at this moment, their texts `prefix` and a number from 0. The time
// is read when this is called, so that under a faked clock each is a Date of the fake's: the
// session's validation takes no other while the fake is in force.
const batch = (count: number, prefix = "n"): ReportedGadgetConsoleLog[] =>
  Array.from({ length: count }, (_, i) => ({ time: new Date(), level: "log", text: prefix + i }));

// The line written for a call the owner's browser reported for `workpieceId`, under no chat.
const reportedLine = (impl: any, entry: ReportedGadgetConsoleLog, workpieceId = GADGET_ID) => ({
  component: "gadget.console", event: "gadget.console.entry", message: "gadget console entry",
  gadgetId: impl.ctx.id.toString(), workpieceId, consoleSource: "client", userId: OWNER.id,
  consoleLevel: entry.level, time: entry.time.toISOString(), text: entry.text,
});

// The marker written with a report of the owner's for the gadget, under no chat.
const reportedMarker = (impl: any, droppedCount: number) => ({
  component: "gadget.console", event: "gadget.console.dropped",
  message: "gadget console entries dropped", gadgetId: impl.ctx.id.toString(),
  workpieceId: GADGET_ID, consoleSource: "client", userId: OWNER.id, droppedCount,
  time: expect.any(String), text: `${droppedCount} entries dropped`,
});

// A moment for the cases that fake the clock.
const NOON = Date.parse("2026-01-02T12:00:00Z");

describe("recording what a session reports of a gadget's UI", () => {
  // The flag changes nothing, and that is deliberate: the backend's logs are treated as
  // sensitive, read only by whoever can read the Cloudflare account's Workers logs, so the flag
  // does not withhold console output from them (docs/gadget-console-logs.md).
  it.each([
    ["a workspace", (_impl: any) => {}],
    ["a workspace that holds restricted data",
      (impl: any) => impl.storage.containsRestrictedData.put(true)],
  ])("writes one line for a call reported in %s, under the session's user", (_name, prepare) =>
      withSession(async (impl, client) => {
    prepare(impl);
    let entry = reported("boom", "error");

    await client.reportGadgetConsoleLogs(GADGET_ID, null, [entry]);

    // Key for key: the workspace, the gadget, the session's user, and no chat.
    expect(lines()).toStrictEqual([{
      component: "gadget.console", event: "gadget.console.entry",
      message: "gadget console entry", gadgetId: impl.ctx.id.toString(), workpieceId: GADGET_ID,
      consoleSource: "client", userId: OWNER.id, consoleLevel: "error",
      time: "2026-01-02T03:04:05.678Z", text: "boom",
    }]);
    expect(lines()).toStrictEqual([reportedLine(impl, entry)]);
    expect(markers()).toHaveLength(0);
  }));

  // What decides is #resolveGadgetChatId, as for the server's entries: a chat is named only
  // while it proposes a change to the gadget.
  it("names the chat only while it proposes a change to the gadget", () =>
      withSession(async (impl, client) => {
    let chatId = await client.newChat("Hello", null);
    let entry = reported("boom", "error");

    // The chat proposes nothing, so the UI it showed was the mainline's.
    await client.reportGadgetConsoleLogs(GADGET_ID, chatId, [entry]);
    expect(lines()).toStrictEqual([reportedLine(impl, entry)]);

    impl.proposedChangeWorkpieceIds = () => [GADGET_ID];
    await client.reportGadgetConsoleLogs(GADGET_ID, chatId, [entry]);
    expect(lines()).toHaveLength(2);
    expect(lines()[1]).toStrictEqual({ ...reportedLine(impl, entry), chatId });
  }));

  it.each([
    ["an unknown gadget", 999, null, "log", /No such gadget: 999/],
    ["a worktree", WORKTREE_ID, null, "log", /is a worktree, not a gadget/],
    ["an unknown chat", GADGET_ID, 424242, "log", /No such chatId: 424242/],
    // A workspace's first chat is chat 0, and this workspace has none.
    ["chat 0 where there is none", GADGET_ID, 0, "log", /No such chatId: 0/],
    // Refused by the session's validation, before the method runs.
    ["a level no console has", GADGET_ID, null, "fatal", /\[2\]\[0\]\.level: expected union/],
  ] as const)("refuses %s, and writes nothing", (_name, gadgetId, chatId, level, error) =>
      withSession(async (impl, client) => {
    let refused = { time: AT, level, text: "refused" } as ReportedGadgetConsoleLog;
    // Called inside an async function: validation throws where the method is called, which on
    // the session itself is here and not in the promise it returns.
    await expect(async () => client.reportGadgetConsoleLogs(gadgetId, chatId, [refused]))
        .rejects.toThrow(error);

    // A report resolves once its lines are written, so the one that follows a refusal is the
    // only one written.
    let entry = reported("accepted");
    await client.reportGadgetConsoleLogs(GADGET_ID, null, [entry]);
    expect(lines()).toStrictEqual([reportedLine(impl, entry)]);
    expect(markers()).toHaveLength(0);
  }));

  it("leaves nothing of a token that straddles the cut", () =>
      withSession(async (_impl, client) => {
    let token = "A1b2C3d4E5".repeat(4);
    // The token starts five characters before the kept length.
    let text = (words(1987) + " Bearer " + token + " " + words(4000)).slice(0, 4000);

    await client.reportGadgetConsoleLogs(GADGET_ID, null, [reported(text)]);

    let kept = (words(1987) + " Bearer [redacted] " + words(4000)).slice(0, 1999) + "…";
    expect(kept).toHaveLength(2000);
    expect(lines().map(line => line.text)).toStrictEqual([kept]);
    expect(kept).not.toContain("A1b2");
  }));

  it("records the first entries of a call up to the cap, and marks the rest", () =>
      withSession(async (impl, client) => {
    let entries = batch(MAX_GADGET_CONSOLE_LOGS_PER_CALL + 5);

    await client.reportGadgetConsoleLogs(GADGET_ID, null, entries);

    expect(lines()).toStrictEqual(
        entries.slice(0, MAX_GADGET_CONSOLE_LOGS_PER_CALL).map(entry => reportedLine(impl, entry)));
    expect(markers()).toStrictEqual([reportedMarker(impl, 5)]);
    // The marker comes first.
    expect(warn.mock.invocationCallOrder.at(-1))
        .toBeLessThan(Math.min(...info.mock.invocationCallOrder));
  }));

  it("holds a gadget to its entries a minute, and marks what it drops once a minute", () =>
      withSession(async (impl, client) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(NOON);
      let sent: ReportedGadgetConsoleLog[] = [];
      for (let call = 0; call < 6; call++) {
        let entries = batch(MAX_GADGET_CONSOLE_LOGS_PER_CALL, `call${call}-`);
        await client.reportGadgetConsoleLogs(GADGET_ID, null, entries);
        sent.push(...entries);
      }
      expect(sent).toHaveLength(GADGET_CONSOLE_LOGS_PER_MINUTE);
      expect(lines()).toStrictEqual(sent.map(entry => reportedLine(impl, entry)));
      expect(markers()).toHaveLength(0);

      // The minute is used up: the next call's entries are dropped, and marked at once.
      await client.reportGadgetConsoleLogs(GADGET_ID, null, batch(10, "over-"));
      expect(lines()).toHaveLength(GADGET_CONSOLE_LOGS_PER_MINUTE);
      expect(markers()).toStrictEqual([reportedMarker(impl, 10)]);

      // A gadget is marked once a minute, so these five wait for its next.
      await client.reportGadgetConsoleLogs(GADGET_ID, null, batch(5, "later-"));
      expect(lines()).toHaveLength(GADGET_CONSOLE_LOGS_PER_MINUTE);
      expect(markers()).toHaveLength(1);

      // Another gadget's minute is its own.
      let [other] = batch(1, "other-");
      await client.reportGadgetConsoleLogs(OTHER_GADGET_ID, null, [other]);
      expect(lines().at(-1)).toStrictEqual(reportedLine(impl, other, OTHER_GADGET_ID));
      expect(lines()).toHaveLength(GADGET_CONSOLE_LOGS_PER_MINUTE + 1);
      expect(markers()).toHaveLength(1);

      vi.setSystemTime(NOON + 60_000);
      let [next] = batch(1, "next-");
      await client.reportGadgetConsoleLogs(GADGET_ID, null, [next]);
      expect(lines().at(-1)).toStrictEqual(reportedLine(impl, next));
      expect(lines()).toHaveLength(GADGET_CONSOLE_LOGS_PER_MINUTE + 2);
      expect(markers()).toStrictEqual([reportedMarker(impl, 10), reportedMarker(impl, 5)]);
    } finally {
      vi.useRealTimers();
    }
  }));

  // What this varies is the chat the calls came under: a marker's count is the gadget's,
  // whatever chat its calls named (the method's doc), while its labels are those of the call
  // that brings it. This file has one session, so it says nothing of users: two reporters that
  // share a gadget's minute and its count are in use-gadget-access.test.ts.
  it("labels a marker with the call that brings it, whichever calls dropped what it counts", () =>
      withSession(async (impl, client) => {
    let chatId = await client.newChat("Hello", null);
    impl.proposedChangeWorkpieceIds = () => [GADGET_ID];
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(NOON);
      for (let call = 0; call < 6; call++) {
        await client.reportGadgetConsoleLogs(
            GADGET_ID, null, batch(MAX_GADGET_CONSOLE_LOGS_PER_CALL));
      }
      await client.reportGadgetConsoleLogs(GADGET_ID, null, batch(10));
      expect(markers()).toStrictEqual([reportedMarker(impl, 10)]);
      await client.reportGadgetConsoleLogs(GADGET_ID, null, batch(5));
      expect(markers()).toHaveLength(1);

      // The five were reported under no chat, and are marked under the chat of this call.
      vi.setSystemTime(NOON + 60_000);
      let [next] = batch(1, "next-");
      await client.reportGadgetConsoleLogs(GADGET_ID, chatId, [next]);
      expect(markers()).toHaveLength(2);
      expect(markers()[1]).toStrictEqual({ ...reportedMarker(impl, 5), chatId });
      expect(lines().at(-1)).toStrictEqual({ ...reportedLine(impl, next), chatId });
    } finally {
      vi.useRealTimers();
    }
  }));

  // A report that brings neither an entry to record nor a marker to write ends in the Overseer,
  // which makes no request for it. Two kinds do: one for a gadget whose minute is used up and
  // marked, and an empty one, whose gadget and chat the session checks all the same. No clock is
  // faked: the gadget's minute runs from its first report, and the case takes far less.
  it("mints no writer for a report that leaves nothing to record or mark", () =>
      withSession(async (impl, client) => {
    for (let call = 0; call < 6; call++) {
      await client.reportGadgetConsoleLogs(
          GADGET_ID, null, batch(MAX_GADGET_CONSOLE_LOGS_PER_CALL));
    }
    await client.reportGadgetConsoleLogs(GADGET_ID, null, batch(5));
    expect(lines()).toHaveLength(GADGET_CONSOLE_LOGS_PER_MINUTE);
    expect(markers()).toStrictEqual([reportedMarker(impl, 5)]);

    // A writer minted from here on fails its report, which would log that and reject.
    replaceGadgetConsoleLogLoopback(impl, () => { throw new Error("minted"); });
    await client.reportGadgetConsoleLogs(GADGET_ID, null, batch(5));
    await client.reportGadgetConsoleLogs(OTHER_GADGET_ID, null, []);
    await expect(client.reportGadgetConsoleLogs(999, null, []))
        .rejects.toThrow(/No such gadget: 999/);
    await expect(client.reportGadgetConsoleLogs(GADGET_ID, 424242, []))
        .rejects.toThrow(/No such chatId: 424242/);

    expect(warn.mock.calls.map(([line]) => line)
        .filter(line => line?.event === "gadget.console.record.failed")).toHaveLength(0);
    expect(lines()).toHaveLength(GADGET_CONSOLE_LOGS_PER_MINUTE);
    expect(markers()).toHaveLength(1);
  }));

  it.each([
    ["rejects", () => ({ client: async () => { throw new Error("down"); } }), /down/],
    ["cannot be minted", () => { throw new Error("no entrypoint"); }, /no entrypoint/],
  ])("logs a batch whose writer %s, and fails the report", (_name, loopback, failure) =>
      withSession(async (impl, client) => {
    replaceGadgetConsoleLogLoopback(impl, loopback);

    await expect(client.reportGadgetConsoleLogs(GADGET_ID, null, [reported("unwritten-zzq")]))
        .rejects.toThrow(failure);

    let failed = warn.mock.calls.map(([line]) => line)
        .filter(line => line?.event === "gadget.console.record.failed");
    expect(failed).toStrictEqual([expect.objectContaining({
      component: "workshop.overseer", event: "gadget.console.record.failed",
      message: "failed to record reported gadget console output",
      gadgetId: impl.ctx.id.toString(), error: expect.stringMatching(failure),
    })]);
    // The line holds nothing of what was reported.
    expect(JSON.stringify(failed)).not.toContain("unwritten-zzq");
    expect(lines()).toHaveLength(0);
  }));

  // The limiter has counted a marker's drops by the time the marker's write fails, so the
  // Overseer has them counted again: otherwise no marker would ever hold them.
  it("counts what a marker that could not be written held with the gadget's next", () =>
      withSession(async (impl, client) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(NOON);
      for (let call = 0; call < 6; call++) {
        await client.reportGadgetConsoleLogs(
            GADGET_ID, null, batch(MAX_GADGET_CONSOLE_LOGS_PER_CALL));
      }
      await client.reportGadgetConsoleLogs(GADGET_ID, null, batch(10));
      expect(markers()).toStrictEqual([reportedMarker(impl, 10)]);
      // Seven more wait for the gadget's next minute, whose first report cannot be written.
      await client.reportGadgetConsoleLogs(GADGET_ID, null, batch(7));

      vi.setSystemTime(NOON + 60_000);
      let ctx = impl.ctx;
      let handed: number[] = [];
      replaceGadgetConsoleLogLoopback(impl, () => ({
        client: async (...args: unknown[]) => {
          handed.push(args[4] as number);
          throw new Error("down");
        },
      }));
      await expect(client.reportGadgetConsoleLogs(GADGET_ID, null, batch(3)))
          .rejects.toThrow(/down/);
      expect(handed).toStrictEqual([7]);
      impl.ctx = ctx;

      // A gadget is marked once a minute, written or not, so the seven wait for the one after.
      await client.reportGadgetConsoleLogs(GADGET_ID, null, batch(1));
      expect(markers()).toHaveLength(1);
      vi.setSystemTime(NOON + 120_000);
      await client.reportGadgetConsoleLogs(GADGET_ID, null, batch(1));
      expect(markers()).toStrictEqual([reportedMarker(impl, 10), reportedMarker(impl, 7)]);
    } finally {
      vi.useRealTimers();
    }
  }));

  it("delivers nothing of a report to a live subscriber", () =>
      withSession(async (impl, client) => {
    // (onRpcBroken must exist on the recorder: a native stub over a plain object forwards it.)
    let received: Received[] = [];
    using recorder = new NativeRpcStub({
      event: async (chatId: number | null, logs: ConsoleLogEvent[]) => {
        for (let { level, message } of logs) received.push({ chatId, level, message });
      },
      onRpcBroken: () => {},
    });
    using _subscription = await impl.subscribeToConsoleLogs(recorder);

    let entry = reported("reported");
    await client.reportGadgetConsoleLogs(GADGET_ID, null, [entry]);
    expect(lines()).toStrictEqual([reportedLine(impl, entry)]);

    // A subscriber is sent its events in order, so once this one has arrived anything the report
    // had delivered would have arrived before it. Without it the assertion below would pass
    // before any delivery could have landed.
    await impl.deliverGadgetLogs(
        null, [{ timestamp: new Date(), level: "info", message: ["sentinel"] }]);
    await vi.waitFor(() => expect(received).not.toHaveLength(0));
    expect(received).toStrictEqual([{ chatId: null, level: "info", message: ["sentinel"] }]);
  }));

  // (The written line would show nothing here: the writer cuts whatever it is handed.)
  it("hands its writer no more of a text than is read", () =>
      withSession(async (impl, client) => {
    let handed: unknown[][] = [];
    replaceGadgetConsoleLogLoopback(
        impl, () => ({ client: async (...args: unknown[]) => { handed.push(args); } }));

    await client.reportGadgetConsoleLogs(GADGET_ID, null, [reported("x".repeat(1_000_000))]);

    expect(handed).toHaveLength(1);
    let entries = handed[0][3] as ReportedGadgetConsoleLog[];
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toHaveLength(MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH);
  }));

  // Validation lets members it does not know through, so an entry can carry any label a line
  // has. None is recorded: a line's user and labels are the session's and the kernel's.
  it("records nothing a client adds to an entry", () => withSession(async (impl, client) => {
    let forged = {
      time: AT, level: "error", text: "boom", userId: "mallory", source: "server", gadgetId: 999,
      chatId: 77, workpieceId: 5, consoleSource: "server", consoleLevel: "debug", droppedCount: 9,
      event: "forged", component: "forged", message: "forged",
    } as ReportedGadgetConsoleLog;

    await client.reportGadgetConsoleLogs(GADGET_ID, null, [forged]);
    expect(lines()).toStrictEqual([reportedLine(impl, reported("boom", "error"))]);
    expect(markers()).toHaveLength(0);

    let handed: unknown[][] = [];
    replaceGadgetConsoleLogLoopback(
        impl, () => ({ client: async (...args: unknown[]) => { handed.push(args); } }));
    await client.reportGadgetConsoleLogs(GADGET_ID, null, [forged]);
    expect(handed).toStrictEqual(
        [[GADGET_ID, null, OWNER.id, [{ time: AT, level: "error", text: "boom" }], 0]]);
  }));

  // "false" stands beside the unset variable because OverseerImpl.reportGadgetConsoleLogs has to
  // ask isGadgetConsoleLogRecordingEnabled(): a site that read the variable's truthiness instead
  // would record under "false", and pass with the unset variable alone.
  it.each([
    ["unset", null],
    ['"false"', "false"],
  ])("checks a report and records nothing while the variable is %s", (_name, recording) =>
      withSession(async (impl, client) => {
    // A report awaits its write, so nothing written by the time it resolves is nothing written
    // at all.
    await client.reportGadgetConsoleLogs(
        GADGET_ID, null, batch(MAX_GADGET_CONSOLE_LOGS_PER_CALL + 5));
    expect(lines()).toHaveLength(0);
    expect(markers()).toHaveLength(0);

    await expect(client.reportGadgetConsoleLogs(999, null, [reported("boom")]))
        .rejects.toThrow(/No such gadget: 999/);
    await expect(client.reportGadgetConsoleLogs(GADGET_ID, 424242, [reported("boom")]))
        .rejects.toThrow(/No such chatId: 424242/);

    // No writer is so much as minted.
    replaceGadgetConsoleLogLoopback(impl, () => { throw new Error("minted"); });
    await client.reportGadgetConsoleLogs(GADGET_ID, null, [reported("boom")]);
    expect(warn).not.toHaveBeenCalled();
  }, recording));
});

describe("recording what a gadget's tail is handed", () => {
  // Calls tail() with the trace of one request of the gadget's that made one console call, on a
  // GadgetTailLoopback whose env holds `value` as the switch, and gives what it delivered for
  // live subscribers. The entrypoint's ctx is the props and the one export that tail() reads.
  async function tail(value: unknown): Promise<ConsoleLogEvent[][]> {
    let delivered: ConsoleLogEvent[][] = [];
    let ctx = {
      props: { gadgetId: GADGET_ID, overseerId: "ws" },
      exports: {
        OverseerDurableObject: {
          idFromString: (id: string) => id,
          get: () => ({
            deliverGadgetLogs: async (_chatId: number | null, logs: ConsoleLogEvent[]) => {
              delivered.push(logs);
            },
          }),
        },
      },
    };
    let loopback = new GadgetTailLoopback(ctx as any, { RECORD_GADGET_CONSOLE_LOGS: value } as any);
    await loopback.tail(
        [{ logs: [{ timestamp: AT.getTime(), level: "log", message: ["tail-zzq"] }],
           exceptions: [] } as any]);
    return delivered;
  }

  const DELIVERED = [[{ timestamp: AT, level: "log", message: ["tail-zzq"] }]];

  it('writes a line for a console call while the variable is "true", and delivers the call',
      async () => {
    expect(await tail("true")).toStrictEqual(DELIVERED);
    expect(lines()).toStrictEqual([{
      component: "gadget.console", event: "gadget.console.entry", message: "gadget console entry",
      gadgetId: "ws", workpieceId: GADGET_ID, consoleSource: "server", consoleLevel: "log",
      time: AT.toISOString(), text: "tail-zzq",
    }]);
  });

  // tail() has to ask isGadgetConsoleLogRecordingEnabled(), as the Overseer's two sites do: one
  // that read the variable's truthiness would record under every value here but the first. The
  // last has no string form, and reading it must not cost live subscribers the call.
  it.each([
    ["unset", undefined],
    ['"false"', "false"],
    ['"TRUE"', "TRUE"],
    ['"1"', "1"],
    ["a JSON true", true],
    ["a JSON object", { toString: "true" }],
  ])("writes nothing while the variable is %s, and still delivers the call",
      async (_name, value) => {
    // An invalid value is reported, as an error line.
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await tail(value)).toStrictEqual(DELIVERED);
    expect(lines()).toHaveLength(0);
  });
});
