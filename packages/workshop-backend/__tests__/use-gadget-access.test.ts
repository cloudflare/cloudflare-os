// A "use" collaborator is admitted to a restricted workspace shell that lists only the gadgets
// their access includes, and is verified for each gadget as they get it: getGadget re-reads their
// live access, refuses anything it does not include exactly like a gadget that doesn't exist, and
// verifies them against that one gadget's scope -- so a failure on one gadget leaves the others
// alone. Their Outputs index is filtered the same way. They may also report the console output of
// a gadget they hold, which checks the same live access and verifies nobody.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding) with the real sharing
// graph; a forged UseOverseerInterface (openFakeOverseer) delegates to it, and gatekeeper facets
// and User DOs are the only fakes.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  MAX_GADGET_CONSOLE_LOGS_PER_CALL,
  type CollaboratorAccess, type GadgetClient, type PermissionEdge, type ReportedGadgetConsoleLog,
  type WorkpieceSummary, type WorkpiecesSubscriber,
} from "@gadgets/workshop-shared/api";
import { GADGET_CONSOLE_LOGS_PER_MINUTE } from "../src/gadget-console-log.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { GatekeeperRecord } from "../src/storage-schema/overseer-storage.js";
import type { WorkspaceOutputEntry } from "../src/storage-schema/user-storage.js";
import { openFakeOverseer } from "./fixtures.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type ObserverImpl = OverseerDurableObject["impl"];

const OWNER = "owner";
// openFakeOverseer opens "use" sessions as this User DO and profile.
const VIEWER_USER = "viewer-id";
const VIEWER = `${VIEWER_USER}-profile`;

// Tests replace the facet factory, so the stored class is never instantiated.
const fakeGatekeeperClass = {} as unknown as GatekeeperRecord["class"];

let doCounter = 0;

async function withImpl(fn: (impl: ObserverImpl) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`use-gadget-access-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    // (Bracket access reaches the private field with its real type.)
    let impl = instance["impl"];
    impl.ownerProfileId = OWNER;
    await fn(impl);
  });
}

function seedGatekeeper(impl: ObserverImpl, id: number): void {
  impl.storage.gatekeepers.put({
    id, resourceTitle: `Connection ${id}`, class: fakeGatekeeperClass,
    creationSpec: {
      type: "gatekeeper", vendorId: "testvendor", resourceUrl: `https://example.com/${id}`,
      typeUrlPattern: "https://*",
    },
  });
}

// A gadget binding `target` when given; `pending` keeps it provisional to chat 1.
function seedGadget(impl: ObserverImpl, id: number,
                    opts: { target?: number, pending?: boolean } = {}): void {
  impl.storage.gadgets.put({
    type: "gadget", id, title: `Gadget ${id}`, created: new Date(0), bindingName: `G${id}`,
    bindings: opts.target === undefined ? {} : { DB: { target: opts.target } },
    ...(opts.pending ? { pending: { chatId: 1 } } : {}),
  });
}

// The owner's grant of every gadget to the viewer, as made before gadgets were shared singly.
function shareEveryGadget(impl: ObserverImpl): void {
  let addedBy: PermissionEdge[] =
      [{ type: "user", sharer: OWNER, created: new Date(0), role: "use" }];
  impl.storage.collaborators.put({ profile: { id: VIEWER, name: "Viewer" }, addedBy });
}

// The owner's grants of single gadgets to the viewer.
function shareGadgets(impl: ObserverImpl, gadgetIds: number[]): void {
  let addedBy: PermissionEdge[] = gadgetIds.map(gadgetId => ({
    type: "user", sharer: OWNER, created: new Date(0), role: "use", gadgetId,
  }));
  impl.storage.collaborators.put({ profile: { id: VIEWER, name: "Viewer" }, addedBy });
}

// Legacy-protocol facets recording which connections the viewer was registered on, refusing
// those in `refuse`.
function legacyFacets(impl: ObserverImpl, refuse: ReadonlySet<number> = new Set()): number[] {
  let adds: number[] = [];
  const getFacet = async (id: number) => ({
    describe: async () => ({
      url: `https://example.com/${id}`, title: `Connection ${id}`, snippet: "",
      suggestedBindingName: "C", tsType: "C",
    }),
    addObserver: async () => {
      if (refuse.has(id)) throw new Error("access revoked upstream");
      adds.push(id);
    },
    removeObserver: async () => {},
  });
  // These direct-DO tests exercise only the legacy observer methods, not the full RPC facet.
  impl.getGatekeeperFacet = getFacet as unknown as ObserverImpl["getGatekeeperFacet"];
  return adds;
}

// The viewer's User DO: always has the account and always mints a verifier.
const viewerUser = {
  id: { toString: () => VIEWER_USER },
  getVerifier: async () => ({}),
  describeConnectedAccount: async () => null,
  whoami: async () => ({ type: "user", id: VIEWER, name: "Viewer" }),
  recordSharedWorkspaceOpen: async () => {},
};

// A "use" session over the real impl's access check, verification and session counting.
function openViewer(impl: ObserverImpl, access: CollaboratorAccess, extra: object = {}) {
  return openFakeOverseer({ gadgets: impl.storage.gadgets }, { role: "use", access, impl: {
    users: { idFromString: (id: string) => id, get: () => viewerUser },
    joinSession: (kind: "use", gadgetId?: number) => impl.joinSession(kind, gadgetId),
    authorizeGadget: (...args: Parameters<ObserverImpl["authorizeGadget"]>) =>
        impl.authorizeGadget(...args),
    ...extra,
  } });
}

function dispose(value: unknown): void {
  (value as Disposable)[Symbol.dispose]();
}

describe("UseOverseerInterface.getGadget", () => {
  it("refuses a gadget the viewer's access doesn't include, revealing nothing", () =>
      withImpl(async impl => {
    seedGatekeeper(impl, 1);
    seedGadget(impl, 100);
    seedGadget(impl, 101, { target: 1 });
    shareGadgets(impl, [100]);
    let adds = legacyFacets(impl);
    let client = await openViewer(impl, { role: "use", gadgetIds: [100] });

    // Exactly the error a missing gadget gets, and nobody is verified for it.
    await expect(client.getGadget(101)).rejects.toThrow("No such gadget: 101");
    await expect(client.getGadget(999)).rejects.toThrow("No such gadget: 999");
    expect(adds).toEqual([]);
    expect(impl.storage.observers.get(VIEWER)).toBeUndefined();
    dispose(client);
  }));

  it("refuses a still-provisional gadget even when a grant names it", () =>
      withImpl(async impl => {
    seedGadget(impl, 100, { pending: true });
    shareGadgets(impl, [100]);
    legacyFacets(impl);
    let client = await openViewer(impl, { role: "use", gadgetIds: "all" });

    await expect(client.getGadget(100)).rejects.toThrow("No such gadget: 100");
    dispose(client);
  }));

  it("re-reads live access rather than trusting what the shell was opened with", () =>
      withImpl(async impl => {
    seedGadget(impl, 100);
    seedGadget(impl, 101);
    shareGadgets(impl, [100]);
    legacyFacets(impl);
    // The shell's snapshot still lists 101, but the grant for it is gone.
    let client = await openViewer(impl, { role: "use", gadgetIds: [100, 101] });

    await expect(client.getGadget(101)).rejects.toThrow("No such gadget: 101");
    dispose(await client.getGadget(100));
    dispose(client);
  }));

  it("verifies the viewer for only the gadget they get", () => withImpl(async impl => {
    seedGatekeeper(impl, 1);
    seedGatekeeper(impl, 2);
    seedGadget(impl, 100, { target: 1 });
    seedGadget(impl, 101, { target: 2 });
    shareGadgets(impl, [100, 101]);
    impl.storage.observers.put(
        { profileId: VIEWER, observerId: "obs-v", accountChoices: { 1: 10, 2: 20 } });
    let adds = legacyFacets(impl);
    let client = await openViewer(impl, { role: "use", gadgetIds: [100, 101] });

    let gadget = await client.getGadget(100);

    expect(adds).toEqual([1]);
    dispose(gadget);
    dispose(client);
  }));

  it("a failure on one gadget leaves the viewer's other gadgets alone", () =>
      withImpl(async impl => {
    seedGatekeeper(impl, 1);
    seedGatekeeper(impl, 2);
    seedGadget(impl, 100, { target: 1 });
    seedGadget(impl, 101, { target: 2 });
    shareGadgets(impl, [100, 101]);
    let record = { profileId: VIEWER, observerId: "obs-v", accountChoices: { 1: 10, 2: 20 } };
    impl.storage.observers.put(record);
    let adds = legacyFacets(impl, new Set([2]));
    let restarts: string[] = [];
    impl.scheduleAccessRestart = async (reason: string) => { restarts.push(reason); };
    let client = await openViewer(impl, { role: "use", gadgetIds: [100, 101] });

    let first: GadgetClient = await client.getGadget(100);
    await expect(client.getGadget(101)).rejects.toThrow(/could not confirm/);

    // Her record (account choices, not a verification result) is untouched, nothing restarted,
    // and the gadget she already holds -- and a fresh get of it -- still work.
    expect(impl.storage.observers.get(VIEWER)).toEqual(record);
    expect(restarts).toEqual([]);
    let again = await client.getGadget(100);
    expect(adds).toEqual([1, 1]);
    dispose(again);
    dispose(first);
    dispose(client);
  }));
});

describe("what a use session lists", () => {
  it("subscribeToWorkpieces lists only the gadgets the viewer's access includes", () =>
      withImpl(async impl => {
    seedGadget(impl, 100);
    seedGadget(impl, 101);
    seedGadget(impl, 102, { pending: true });
    let client = await openViewer(impl, { role: "use", gadgetIds: [100, 102] }, {
      subscribeToWorkpieces: (...args: Parameters<ObserverImpl["subscribeToWorkpieces"]>) =>
          impl.subscribeToWorkpieces(...args),
    });
    let listed: number[] = [];
    let ready = Promise.withResolvers<void>();
    let subscriber: WorkpiecesSubscriber = {
      entry: async (summary: WorkpieceSummary) => { listed.push(summary.id); },
      removed: async () => {},
      ready: async () => { ready.resolve(); },
    };
    // (onRpcBroken must exist on the mock: a native stub over a plain object forwards it.)
    using stub = new NativeRpcStub({ ...subscriber, onRpcBroken: () => {} });

    let sub = await client.subscribeToWorkpieces(
        stub as unknown as Parameters<typeof client.subscribeToWorkpieces>[0]);
    await ready.promise;

    // 101 isn't hers, and 102 is still provisional to a chat.
    expect(listed).toEqual([100]);
    dispose(sub);
    dispose(client);
  }));

  it("open() syncs the viewer's Outputs index with only their gadgets", () =>
      withImpl(async impl => {
    seedGadget(impl, 100);
    seedGadget(impl, 101);
    let synced = Promise.withResolvers<WorkspaceOutputEntry[]>();
    let client = await openViewer(impl, { role: "use", gadgetIds: [101] }, {
      outputsSnapshot: (access?: CollaboratorAccess) => impl.outputsSnapshot(access),
      syncOutputsTo: async (_user: unknown, snapshot: WorkspaceOutputEntry[]) => {
        synced.resolve(snapshot);
      },
    });

    expect((await synced.promise).map(entry => entry.workpieceId)).toEqual([101]);
    dispose(client);
  }));

  it("the Outputs fan-out filters each watcher by their access", () => withImpl(async impl => {
    seedGadget(impl, 100);
    seedGadget(impl, 101);
    impl.ownerId = "owner-user";
    let pushes = new Map<string, PromiseWithResolvers<number[]>>(
        ["owner-user", VIEWER_USER, "legacy-user"].map(id => [id, Promise.withResolvers()]));
    impl.users = {
      idFromString: (id: string) => id,
      get: (id: string) => ({
        syncWorkspaceOutputs: async (_workspace: string, snapshot: WorkspaceOutputEntry[]) => {
          pushes.get(id)!.resolve(snapshot.map(entry => entry.workpieceId));
        },
      }),
    } as unknown as ObserverImpl["users"];
    let leaveViewer = impl.joinOutputsFanout(VIEWER_USER, { role: "use", gadgetIds: [100] });
    let leaveLegacy = impl.joinOutputsFanout("legacy-user", { role: "use", gadgetIds: "all" });

    impl.markOutputsDirty();

    expect(await pushes.get("owner-user")!.promise).toEqual([100, 101]);
    expect(await pushes.get(VIEWER_USER)!.promise).toEqual([100]);
    expect(await pushes.get("legacy-user")!.promise).toEqual([100, 101]);
    leaveViewer();
    leaveLegacy();
  }));
});

// A "use" session whose reports reach the real impl, in a deployment that records gadget console
// output.
function openReporter(impl: ObserverImpl, access: CollaboratorAccess) {
  impl.env = { ...impl.env, RECORD_GADGET_CONSOLE_LOGS: "true" };
  return openViewer(impl, access, {
    holdsGadget: (...args: Parameters<ObserverImpl["holdsGadget"]>) => impl.holdsGadget(...args),
    reportGadgetConsoleLogs: (...args: Parameters<ObserverImpl["reportGadgetConsoleLogs"]>) =>
        impl.reportGadgetConsoleLogs(...args),
  });
}

// When the reported calls of the cases that fake no clock were made.
const AT = new Date("2026-01-02T03:04:05.678Z");
const reported = (text: string): ReportedGadgetConsoleLog => ({ time: AT, level: "log", text });

// `count` reported calls made at this moment, their texts "n0", "n1" and so on. The time is read
// when this is called, so that under a faked clock each is a Date of the fake's: the session's
// validation takes no other while the fake is in force.
const batch = (count: number): ReportedGadgetConsoleLog[] =>
  Array.from({ length: count }, (_, i) => ({ time: new Date(), level: "log", text: `n${i}` }));

// The `gadget.console` lines among what `spy` was called with, in order.
const gadgetConsoleLines = (spy: MockInstance<typeof console.info>): Record<string, unknown>[] =>
  spy.mock.calls.map(([line]) => line).filter(line => line?.component === "gadget.console");

describe("UseOverseerInterface.reportGadgetConsoleLogs", () => {
  let info: MockInstance<typeof console.info>;
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The entry lines and the markers written so far.
  const lines = () => gadgetConsoleLines(info);
  const markers = () => gadgetConsoleLines(warn);

  it("records what a held gadget's UI logged, under the viewer", () => withImpl(async impl => {
    seedGadget(impl, 100);
    shareGadgets(impl, [100]);
    let client = await openReporter(impl, { role: "use", gadgetIds: [100] });

    await client.reportGadgetConsoleLogs(100, null, [{ time: AT, level: "error", text: "boom" }]);

    expect(lines()).toStrictEqual([{
      component: "gadget.console", event: "gadget.console.entry",
      message: "gadget console entry", gadgetId: impl.ctx.id.toString(), workpieceId: 100,
      consoleSource: "client", userId: VIEWER, consoleLevel: "error", time: AT.toISOString(),
      text: "boom",
    }]);
    expect(markers()).toHaveLength(0);
    dispose(client);
  }));

  it("is capped and rate-limited like any session, and leaves its lines under the viewer", () =>
      withImpl(async impl => {
    seedGadget(impl, 100);
    shareGadgets(impl, [100]);
    let client = await openReporter(impl, { role: "use", gadgetIds: [100] });

    await client.reportGadgetConsoleLogs(100, null, batch(MAX_GADGET_CONSOLE_LOGS_PER_CALL + 5));

    expect(lines().map(line => line.text)).toStrictEqual(
        Array.from({ length: MAX_GADGET_CONSOLE_LOGS_PER_CALL }, (_, i) => `n${i}`));
    expect(markers()).toStrictEqual([expect.objectContaining({
      event: "gadget.console.dropped", droppedCount: 5, text: "5 entries dropped",
      consoleSource: "client", workpieceId: 100,
    })]);
    for (let line of [...lines(), ...markers()]) expect(line.userId).toBe(VIEWER);

    // The rest of the gadget's minute, which runs from its first report: this takes far less.
    for (let call = 0; call < 5; call++) {
      await client.reportGadgetConsoleLogs(100, null, batch(MAX_GADGET_CONSOLE_LOGS_PER_CALL));
    }
    expect(lines()).toHaveLength(GADGET_CONSOLE_LOGS_PER_MINUTE);
    expect(markers()).toHaveLength(1);

    await client.reportGadgetConsoleLogs(100, null, batch(1));
    expect(lines()).toHaveLength(GADGET_CONSOLE_LOGS_PER_MINUTE);
    expect(markers()).toHaveLength(1);
    dispose(client);
  }));

  // No other case has two reporters for one gadget. The owner stands in as the second through
  // the call every session ends in for its own user. Two things are pinned. The minute is the
  // gadget's, whoever reports (GadgetConsoleLogLimiter): the owner's first entry writes nothing,
  // where a budget per session or per user would have recorded it. And a marker counts every
  // reporter's drops for the gadget while it is labelled with the one who brought it (the
  // method's doc): the last marks 3, the owner's one and the viewer's two, under the owner, where
  // a count kept per user would mark 1.
  it("gives a gadget one budget and one count of drops, whoever reports", () =>
      withImpl(async impl => {
    seedGadget(impl, 100);
    shareGadgets(impl, [100]);
    let client = await openReporter(impl, { role: "use", gadgetIds: [100] });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let noon = Date.parse("2026-01-02T12:00:00Z");
      vi.setSystemTime(noon);

      for (let call = 0; call < 6; call++) {
        await client.reportGadgetConsoleLogs(100, null, batch(MAX_GADGET_CONSOLE_LOGS_PER_CALL));
      }
      expect(lines()).toHaveLength(GADGET_CONSOLE_LOGS_PER_MINUTE);
      for (let line of lines()) expect(line.userId).toBe(VIEWER);
      expect(markers()).toHaveLength(0);

      await client.reportGadgetConsoleLogs(100, null, batch(4));
      expect(lines()).toHaveLength(GADGET_CONSOLE_LOGS_PER_MINUTE);
      expect(markers()).toStrictEqual(
          [expect.objectContaining({ droppedCount: 4, userId: VIEWER })]);

      // The viewer used the minute up, and the gadget was marked in it.
      await impl.reportGadgetConsoleLogs(100, null, OWNER, batch(1));
      expect(lines()).toHaveLength(GADGET_CONSOLE_LOGS_PER_MINUTE);
      expect(markers()).toHaveLength(1);

      await client.reportGadgetConsoleLogs(100, null, batch(2));
      expect(lines()).toHaveLength(GADGET_CONSOLE_LOGS_PER_MINUTE);
      expect(markers()).toHaveLength(1);

      vi.setSystemTime(noon + 60_000);
      await impl.reportGadgetConsoleLogs(
          100, null, OWNER, [{ time: new Date(), level: "log", text: "next minute" }]);
      expect(markers()).toHaveLength(2);
      expect(markers()[1]).toMatchObject({
        userId: OWNER, consoleSource: "client", workpieceId: 100, droppedCount: 3,
        text: "3 entries dropped",
      });
      expect(lines()).toHaveLength(GADGET_CONSOLE_LOGS_PER_MINUTE + 1);
      expect(lines().at(-1)).toMatchObject(
          { userId: OWNER, consoleSource: "client", workpieceId: 100, text: "next minute" });
      expect(lines().filter(line => line.userId === OWNER)).toHaveLength(1);
      // The marker comes before the entry it was brought with.
      expect(warn.mock.invocationCallOrder.at(-1))
          .toBeLessThan(info.mock.invocationCallOrder.at(-1)!);
    } finally {
      vi.useRealTimers();
    }
    dispose(client);
  }));

  it("refuses a chat, even for a held gadget", () => withImpl(async impl => {
    seedGadget(impl, 100);
    shareGadgets(impl, [100]);
    let client = await openReporter(impl, { role: "use", gadgetIds: [100] });

    // A workspace's first chat is chat 0.
    for (let chatId of [0, 7]) {
      await expect(client.reportGadgetConsoleLogs(100, chatId, [reported("refused")]))
          .rejects.toThrow(
              "Unauthorized: this collaborator only has permission to use the gadget's UI.");
    }

    // A report resolves once its lines are written, so the one that follows the refusals is the
    // only one written.
    await client.reportGadgetConsoleLogs(100, null, [reported("accepted")]);
    expect(lines().map(line => line.text)).toStrictEqual(["accepted"]);
    expect(markers()).toHaveLength(0);
    dispose(client);
  }));

  it("refuses a gadget the viewer does not hold exactly like one that doesn't exist", () =>
      withImpl(async impl => {
    seedGadget(impl, 100);
    seedGadget(impl, 101);
    seedGadget(impl, 102, { pending: true });
    shareGadgets(impl, [100, 102]);
    let client = await openReporter(impl, { role: "use", gadgetIds: "all" });

    // Outside the viewer's access, and inside it but still provisional to a chat.
    for (let id of [101, 102]) {
      await expect(client.reportGadgetConsoleLogs(id, null, [reported("refused")]))
          .rejects.toThrow(`No such gadget: ${id}`);
    }
    // No such gadget, under an access that includes every id.
    shareEveryGadget(impl);
    await expect(client.reportGadgetConsoleLogs(999, null, [reported("refused")]))
        .rejects.toThrow("No such gadget: 999");

    await client.reportGadgetConsoleLogs(101, null, [reported("accepted")]);
    expect(lines().map(line => line.text)).toStrictEqual(["accepted"]);
    expect(markers()).toHaveLength(0);
    dispose(client);
  }));

  it("accepts a gadget granted since the session opened", () => withImpl(async impl => {
    seedGadget(impl, 100);
    seedGadget(impl, 101);
    shareGadgets(impl, [100]);
    let client = await openReporter(impl, { role: "use", gadgetIds: [100] });

    shareGadgets(impl, [100, 101]);
    await client.reportGadgetConsoleLogs(101, null, [reported("granted")]);

    expect(lines()).toStrictEqual(
        [expect.objectContaining({ workpieceId: 101, userId: VIEWER, text: "granted" })]);
    dispose(client);
  }));

  it("refuses a gadget whose grant is gone, whatever the session was opened with", () =>
      withImpl(async impl => {
    seedGadget(impl, 100);
    seedGadget(impl, 101);
    shareGadgets(impl, [100]);
    // The shell's snapshot still lists 101, but the grant for it is gone.
    let client = await openReporter(impl, { role: "use", gadgetIds: [100, 101] });

    await expect(client.reportGadgetConsoleLogs(101, null, [reported("refused")]))
        .rejects.toThrow("No such gadget: 101");

    await client.reportGadgetConsoleLogs(100, null, [reported("accepted")]);
    expect(lines().map(line => line.text)).toStrictEqual(["accepted"]);
    dispose(client);
  }));

  // Reporting reads nothing, so it verifies nobody. The gadget is bound to a connection because
  // verification does nothing for a gadget that reaches none: a report that verified the viewer
  // with every batch would pass every other case of this describe, whose gadgets bind nothing.
  it("verifies nobody", () => withImpl(async impl => {
    seedGatekeeper(impl, 1);
    seedGadget(impl, 100, { target: 1 });
    shareGadgets(impl, [100]);
    let adds = legacyFacets(impl);
    let client = await openReporter(impl, { role: "use", gadgetIds: [100] });

    // A session that reports without having opened the gadget: the viewer has no observer record,
    // and is given none.
    await client.reportGadgetConsoleLogs(100, null, [reported("unopened")]);
    expect(lines().map(line => line.text)).toStrictEqual(["unopened"]);
    expect(adds).toEqual([]);
    expect(impl.storage.observers.get(VIEWER)).toBeUndefined();

    // The state the Workshop reports in, the viewer having been verified when they opened the
    // gadget: a report that verified would succeed here, registering them again with each batch.
    let record = { profileId: VIEWER, observerId: "obs-v", accountChoices: { 1: 10 } };
    impl.storage.observers.put(record);
    await client.reportGadgetConsoleLogs(100, null, [reported("opened")]);
    expect(lines().map(line => line.text)).toStrictEqual(["unopened", "opened"]);
    expect(adds).toEqual([]);
    expect(impl.storage.observers.get(VIEWER)).toEqual(record);

    // The control: the same viewer, gadget and facets do register once something verifies, so
    // the reports are what left `adds` empty.
    dispose(await client.getGadget(100));
    expect(adds).toEqual([1]);
    dispose(client);
  }));
});
