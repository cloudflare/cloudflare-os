// A gatekeeper that simulated an action may be unable to unwind it when the user discards it
// (Gatekeeper.rejectAction's `restart`): later queued changes were checked against the one being
// withdrawn, and the gadget has already read them. The restart is the Overseer's to perform, and
// the contract allows it "possibly after rejecting other actions" -- so discarding a group has to
// produce one restart after the group, not an abort that cuts its own batch short.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding) driven through a real
// client session. scheduleAccessRestart is replaced with a recorder, since a real ctx.abort()
// would kill the test DO, and scheduler.wait with a clock the test drives, so the idle window
// costs no wall time and the race between a rejection and the wait is the test's to choose.

import { env, RpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OverseerDurableObject } from "../src/overseer";
import { UserDurableObject } from "../src/user";
import { OVERSEER_STORAGE_VERSION } from "../src/storage-schema/overseer-migrations";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

type Impl = OverseerDurableObject["impl"];

// What a gatekeeper answers rejectAction with, per action key.
type Rejection = (action: number) => void | {restart?: boolean};

const USER = {type: "user" as const, id: "discarding-user", name: "Discarding user"};
const GATEKEEPER = 31;
const RESTART_REASON = "Gadget restarted because a drafted change was discarded.";

// REJECTION_RESTART_IDLE_MS in overseer.ts.
const IDLE_MS = 2_000;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// Replaces the clock the deferred restart sleeps on. A wait yields to the event loop once -- so a
// rejection arriving while it sleeps still lands first -- and then jumps to the moment it was
// waiting for. Returns the sleeps that were asked for, which is how long the restart was deferred,
// and a way to let time pass between rejections. A zero-length wait is a yield rather than a
// sleep (markOutputsDirty schedules its flush that way), so it is not recorded.
function fakeClock() {
  let now = Date.now();
  let waits: number[] = [];
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubGlobal("scheduler", {wait: async (ms: number) => {
    let until = now + ms;
    if (ms > 0) waits.push(ms);
    await new Promise(resolve => setTimeout(resolve, 0));
    now = Math.max(now, until);
  }});
  return {waits, advance: (ms: number) => { now += ms; }};
}

// Runs `fn` against a fresh workspace owned by USER holding `actions` pending actions (ids 1..n)
// on connection 31, whose gatekeeper answers each rejectAction with `reject`. The clock is only
// replaced once the workspace is built, so setup keeps the real one.
async function withWorkspace(
    {actions, reject}: {actions: number, reject: Rejection},
    fn: (ctx: {
      client: Awaited<ReturnType<OverseerDurableObject["open"]>>,
      clock: ReturnType<typeof fakeClock>,
      restarts: string[],
      // Makes the scheduled restart throw instead of aborting, as a failing storage.sync() would.
      breakRestarts: (broken: boolean) => void,
      // Waits for everything the workspace has started in the background, including the deferred
      // restart. The restart's own waits resolve through the event loop, so this drains them.
      settle: () => Promise<void>,
      states: () => Promise<string[]>,
    }) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  let user = env.TEST_USER.getByName(crypto.randomUUID());
  await runInDurableObject(user, instance => { instance["storage"].profile.put(USER); });
  await user.newWorkspace(stub.id.toString(), "Discard");

  let restarts: string[] = [];
  let broken = false;
  let background: Promise<unknown>[] = [];
  let visit = <T>(f: (impl: Impl) => T | Promise<T>) =>
      runInDurableObject(env.TEST_OVERSEER.get(stub.id), ({impl}) => f(impl));

  await visit(impl => {
    impl.storage.version.put(OVERSEER_STORAGE_VERSION);
    impl.storage.ownerId.put(user.id.toString());
    impl.ownerId = user.id.toString();
    // A gatekeeper class cannot be minted in a test: record connection 31 with one the workspace
    // never instantiates, and answer what a rejection asks of its facet.
    impl.storage.gatekeepers.put({id: GATEKEEPER, class: {} as any});
    vi.spyOn(impl, "getGatekeeperFacet").mockResolvedValue({
      rejectAction: async (action: number) => reject(action),
    } as unknown as Awaited<ReturnType<Impl["getGatekeeperFacet"]>>);
    for (let id = 1; id <= actions; id++) {
      impl.storage.actions.put({
        id, gatekeeperId: GATEKEEPER, type: "action", action: id, createdAt: new Date(),
        state: "pending", caller: {from: "user"},
        description: {title: `Write ${id}`, description: "", implementsRevert: false,
                      awaitDecision: true},
      });
    }
    // A real abort would kill the test DO; record what was scheduled instead.
    impl.scheduleAccessRestart = async (reason: string) => {
      restarts.push(reason);
      if (broken) throw new Error("storage.sync() failed");
    };
    let waitUntil = impl.ctx.waitUntil.bind(impl.ctx);
    vi.spyOn(impl.ctx, "waitUntil").mockImplementation(task => {
      background.push(task);
      waitUntil(task);
    });
  });

  let clock = fakeClock();
  using closed = new RpcStub(() => {});
  using client = await env.TEST_OVERSEER.get(stub.id).open(user.id.toString(), USER.id, closed);
  await fn({
    client, clock, restarts,
    breakRestarts: (value: boolean) => { broken = value; },
    settle: async () => {
      // A background task may start another (the auto-approval drain does), so drain until none
      // is left rather than once.
      while (background.length) await Promise.allSettled(background.splice(0));
    },
    states: () => visit(impl => [...impl.storage.actions.list()].map(action => action.state)),
  });
}

describe("restarting a workspace after a rejection the gatekeeper could not unwind", () => {
  it("a rejection asking for a restart schedules one", () =>
      withWorkspace({actions: 1, reject: () => ({restart: true})},
                    async ({client, clock, restarts, settle, states}) => {
    await client.rejectAction(1);

    // Deferred, not immediate: the abort waits out the idle window first.
    expect(restarts).toEqual([]);
    await settle();
    expect(clock.waits).toEqual([IDLE_MS]);
    expect(restarts).toEqual([RESTART_REASON]);
    // And the rejection is durable before the abort that follows it.
    expect(await states()).toEqual(["rejected"]);
  }));

  it("a rejection that needs no restart schedules none", () =>
      withWorkspace({actions: 1, reject: () => {}},
                    async ({client, restarts, settle, states}) => {
    await client.rejectAction(1);
    await settle();

    expect(restarts).toEqual([]);
    expect(await states()).toEqual(["rejected"]);
  }));

  it("`restart: false` schedules none either", () =>
      withWorkspace({actions: 1, reject: () => ({restart: false})},
                    async ({client, restarts, settle}) => {
    await client.rejectAction(1);
    await settle();

    expect(restarts).toEqual([]);
  }));

  it("discarding a group restarts once, after the whole group", () =>
      withWorkspace({actions: 4, reject: () => ({restart: true})},
                    async ({client, clock, restarts, settle, states}) => {
    // What a "discard all" does: reject in sequence, never in parallel -- the input gate is open
    // across each gatekeeper call.
    for (let id of [1, 2, 3, 4]) {
      await client.rejectAction(id);
      // Every one of them asked for a restart, and none of them has been able to fire one.
      expect(restarts).toEqual([]);
      clock.advance(IDLE_MS / 2);
    }
    await settle();

    // Each rejection pushed the deadline out, so the group was never cut short, and the four
    // rejections still produced a single restart.
    expect(clock.waits.length).toBeGreaterThan(1);
    expect(restarts).toEqual([RESTART_REASON]);
    expect(await states()).toEqual(["rejected", "rejected", "rejected", "rejected"]);
  }));

  it("only the rejections that ask for it hold the restart open", () =>
      withWorkspace({actions: 3, reject: action => action === 1 ? {restart: true} : undefined},
                    async ({client, clock, restarts, settle, states}) => {
    await client.rejectAction(1);
    // Rejections that need no restart do not extend the window: the deadline stands where the one
    // that asked for it put it.
    clock.advance(IDLE_MS);
    await client.rejectAction(2);
    await client.rejectAction(3);
    await settle();

    expect(clock.waits).toEqual([IDLE_MS]);
    expect(restarts).toEqual([RESTART_REASON]);
    expect(await states()).toEqual(["rejected", "rejected", "rejected"]);
  }));

  it("tries again after a restart that failed to fire", () =>
      withWorkspace({actions: 2, reject: () => ({restart: true})},
                    async ({client, restarts, settle, breakRestarts}) => {
    breakRestarts(true);
    await client.rejectAction(1);
    await settle();
    expect(restarts).toEqual([RESTART_REASON]);

    // That attempt threw, so nothing aborted and the gadget is still reading state nothing backs.
    // The next discard has to be able to schedule its own abort: a latch left set by the failure
    // would silence every restart for the life of the instance, which is worse than restarting.
    breakRestarts(false);
    await client.rejectAction(2);
    await settle();

    expect(restarts).toEqual([RESTART_REASON, RESTART_REASON]);
  }));
});
