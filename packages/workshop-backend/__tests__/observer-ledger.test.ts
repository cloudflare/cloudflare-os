// Kernel-owned observer tracking (observer-ledger.ts): connections that advertise
// ResourceDescription.supportsObserverTracking coexist with legacy ones, import prior reads once,
// report subresources on every real observation, and are verified through each observer's own
// verifier -- failing closed on every malformed or failed answer.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// observer-verification-failure.test.ts); gatekeeper facets, User DOs, verifiers, and the sharing
// graph are the fakes.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import type {
  ObservationAuthorizer, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "../src/overseer.js";
import {
  observerContextKey, type GatekeeperCaller, type GatekeeperRecord, type ObserverContext,
} from "../src/storage-schema/overseer-storage.js";
import { openFakeOverseer } from "./fixtures.js";
import type { BoundHookRecord } from "../src/storage-schema/overseer-storage.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const LEGACY = 1;
const TRACKED = 2;
const GADGET = 100;
const WORKSPACE: ObserverContext = { type: "workspace" };
const chat = (chatId: number): ObserverContext => ({ type: "chat", chatId });
const gadget = (gadgetId: number): ObserverContext => ({ type: "gadget", gadgetId });

type ObserverImpl = OverseerDurableObject["impl"];
// Facet factories are replaced in these tests, so the stored gatekeeper class is never invoked.
const fakeGatekeeperClass = {} as unknown as GatekeeperRecord["class"];

type Check = { profileId: string, ids: string[] };

// One test's fakes: who holds which role, what each profile's verifier answers, and what was
// asked of them.
type World = {
  impl: any;
  instance: OverseerDurableObject;
  roles: Map<string, "build" | "use">;
  // Per profile: answers verifyObserverAccess(ids), or is the whole verifier.
  verifiers: Map<string, unknown>;
  checks: Check[];
  clientUser(profileId: string): any;
};

// `answer` gives the denied IDs from `ids`.
function observerVerifier(world: () => World, profileId: string,
                          answer: (ids: string[]) => string[] | Promise<string[]> = () => []) {
  return {
    verifyObserverAccess: async (ids: string[]) => {
      world().checks.push({ profileId, ids });
      return { denied: await answer(ids) };
    },
  };
}

let doCounter = 0;

async function inOverseer(name: string, fn: (world: World) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(name);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    // (Bracket access reaches the private field with its real type.)
    let impl = instance["impl"];
    impl.ownerProfileId = "owner";
    let world: World = {
      impl,
      instance,
      roles: new Map(),
      verifiers: new Map(),
      checks: [],
      clientUser: (profileId: string) => ({
        getVerifier: async () => {
          let verifier = world.verifiers.get(profileId);
          if (verifier instanceof Error) throw verifier;
          return verifier ?? observerVerifier(() => world, profileId);
        },
        describeConnectedAccount: async () => null,
        listProvidedAccounts: async () => [],
      }),
    };
    world.impl.getSharingManager = async () => ({
      getEffectiveRole: (id: string) => id === "owner" ? "build" : world.roles.get(id),
      computeEffectiveRoles: () => new Map(world.roles),
    });
    world.impl.users = {
      idFromName: (name: string) => name,
      get: (id: string) => world.clientUser(id),
    };
    await fn(world);
  });
}

function withWorld(fn: (world: World) => Promise<void>): Promise<void> {
  return inOverseer(`observer-ledger-${++doCounter}`, fn);
}

function spec(vendorId: string, id: number) {
  return {
    type: "gatekeeper" as const, vendorId, resourceUrl: `https://example.com/${id}`,
    typeUrlPattern: "https://*",
  };
}

function seedLegacy(impl: ObserverImpl, id = LEGACY, extra: Partial<GatekeeperRecord> = {}): void {
  impl.storage.gatekeepers.put({
    id, resourceTitle: `Legacy ${id}`, class: fakeGatekeeperClass,
    creationSpec: spec("legacyvendor", id), ...extra,
  });
}

function seedTracked(impl: ObserverImpl, id = TRACKED): void {
  impl.storage.gatekeepers.put({
    id, resourceTitle: `Tracked ${id}`, class: fakeGatekeeperClass,
    creationSpec: spec("trackedvendor", id), observerTracking: true,
  });
}

// `bindings` maps binding names to connection ids; a bound connection is in "use" scope.
function seedGadget(impl: ObserverImpl, id = GADGET, bindings: Record<string, number> = {}): void {
  impl.storage.gadgets.put({
    type: "gadget", id, title: "G", created: new Date(0), bindingName: `G${id}`,
    bindings: Object.fromEntries(Object.entries(bindings).map(([name, target]) => [name, { target }])),
  });
}

// Requirements are tracked observation audit records, attributed to a context by their caller.
function addRows(impl: ObserverImpl, context: ObserverContext, gatekeeperId: number, ids: string[]): void {
  let caller: GatekeeperCaller = context.type === "chat" ? { from: "agent", chatId: context.chatId }
      : context.type === "gadget" ? { from: "gadget", gadgetId: context.gadgetId }
      : { from: "user" };
  let id = impl.storage.nextActionId.get();
  impl.storage.nextActionId.put(id + 1);
  impl.storage.actions.put({
    id, gatekeeperId, caller, createdAt: new Date(0), state: "approved",
    type: "observation", description: observation({ subresources: ids }),
  });
}

// Every subresource recorded on `context`, whether or not its connection still exists.
function rows(impl: ObserverImpl, context: ObserverContext): string[] {
  let found = new Set<string>();
  for (let record of impl.storage.actions.byObserverContext.get(observerContextKey(context))) {
    if (record.type !== "observation") continue;
    for (let subresource of record.description.subresources ?? []) {
      found.add(`${record.gatekeeperId}:${subresource}`);
    }
  }
  return [...found].toSorted();
}

describe("byte-bounded observation persistence", () => {
  for (let historical of [false, true]) {
    let label = historical ? "historical import" : "live observation";

    it(`keeps every requirement from an oversized ${label}`, () => withWorld(async world => {
      let { impl } = world;
      // Bound, so "use" collaborators are verified against it.
      seedGadget(impl, GADGET, { C: historical ? LEGACY : TRACKED });
      let ids = Array.from({ length: historical ? 20_000 : 10_000 },
          (_, i) => String(i).padStart(512, historical ? "x" : "界"));
      if (historical) {
        seedLegacy(impl);
        fakeFacets(impl, {
          advertise: new Set([LEGACY]), exports: new Map([[LEGACY, async () => ids]]),
        });
        await impl.observerLedger.initialize(LEGACY);
      } else {
        seedTracked(impl);
        await impl.authorizeObservation(TRACKED, observation({ subresources: ids }),
            { from: "gadget", gadgetId: GADGET });
      }
      let connection = historical ? LEGACY : TRACKED;
      expect(impl.observerLedger.requiredSubresources("use").get(connection)).toEqual(ids);
      world.roles.set("carol", "use");
      world.verifiers.set("carol", observerVerifier(() => world, "carol",
          batch => batch.filter(id => id === ids.at(-1))));
      await expect(impl.ensureObserver("carol", world.clientUser("carol"), "use", configureAll))
          .rejects.toThrow(/could not confirm/);
      expect(impl.storage.observers.get("carol")).toBeUndefined();
      world.verifiers.delete("carol");
      await impl.ensureObserver("carol", world.clientUser("carol"), "use", configureAll);
      expect(impl.storage.observers.get("carol").accountChoices).toEqual({ [connection]: connection * 10 });
    }));

    it(`rolls back every chunk and policy change after a failed ${label}`, () =>
        withWorld(async ({ impl }) => {
      let ids = Array.from({ length: historical ? 20_000 : 10_000 },
          (_, i) => String(i).padStart(512, historical ? "x" : "界"));
      if (historical) {
        seedLegacy(impl);
        fakeFacets(impl, {
          advertise: new Set([LEGACY]), exports: new Map([[LEGACY, async () => ids]]),
        });
      } else {
        seedTracked(impl);
      }
      let sharing = await impl.getSharingManager();
      sharing.computeAffectedByOwnerInvitesOnly = () => [];
      impl.getSharingManager = async () => sharing;
      let before = impl.storage.nextActionId.get();
      let put = impl.storage.actions.put.bind(impl.storage.actions);
      let writes = 0;
      impl.storage.actions.put = (record: Parameters<typeof put>[0]) => {
        if (++writes === 2) throw new Error("later chunk failed");
        return put(record);
      };
      let run = () => historical ? impl.observerLedger.initialize(LEGACY)
          : impl.authorizeObservation(TRACKED, observation({
            subresources: ids, containsRestrictedData: true, ownerInvitesOnly: true,
          }), { from: "user" });
      try {
        await expect(run()).rejects.toThrow("later chunk failed");
      } finally {
        impl.storage.actions.put = put;
      }
      expect(impl.storage.nextActionId.get()).toBe(before);
      expect([...impl.storage.actions.list()]).toEqual([]);
      expect(impl.observerLedger.requiredSubresources("build").size).toBe(0);
      expect(impl.storage.containsRestrictedData.get()).toBeFalsy();
      expect(impl.storage.ownerInvitesOnly.get()).toBeFalsy();
      if (historical) expect(impl.observerLedger.isTracked(LEGACY)).toBe(false);
      await run();
      expect(impl.observerLedger.requiredSubresources("build").get(historical ? LEGACY : TRACKED))
          .toEqual(ids);
      if (historical) {
        expect(impl.observerLedger.isTracked(LEGACY)).toBe(true);
      } else {
        expect(impl.storage.containsRestrictedData.get()).toBe(true);
        expect(impl.storage.ownerInvitesOnly.get()).toBe(true);
      }
    }));
  }
});

// Facets: legacy ones advertise nothing; tracked ones advertise support.
function fakeFacets(impl: any, opts: {
  adds?: number[],
  exports?: Map<number, () => Promise<string[]>>,
  advertise?: Set<number>,
} = {}): void {
  impl.getGatekeeperFacet = async (id: number) => ({
    describe: async () => ({
      url: `https://example.com/${id}`, title: `Connection ${id}`, snippet: "",
      suggestedBindingName: "C", tsType: "C",
      ...(opts.advertise?.has(id) || impl.storage.gatekeepers.get(id)?.observerTracking
          ? { supportsObserverTracking: true } : {}),
    }),
    getHistoricalSubresources: () => opts.exports?.get(id)?.() ?? Promise.resolve([]),
    addObserver: async () => { opts.adds?.push(id); },
    removeObserver: async () => {},
    startSession: async () => ({}),
  });
}

const configureAll = {
  configure: async (needs: { gatekeeperId: number }[]) =>
      needs.map(need => ({ gatekeeperId: need.gatekeeperId, accountId: need.gatekeeperId * 10 })),
} as any;

function observation(extra: Partial<ObservationDescription> = {}): ObservationDescription {
  return { title: "Read", description: "A read", ...extra };
}

// Only controller/callback capabilities are faked; the hook row, ledger, and action log use
// real DO storage. Functions cannot be structured-cloned, so attach capabilities on reads.
async function startTrackedHook(world: World, gadgetId?: number) {
  let { impl, instance } = world;
  let deliveries: string[] = [];
  let hooks: ObserverImpl["storage"]["boundHooks"] = impl.storage.boundHooks;
  let get = hooks.get.bind(hooks);
  let put = hooks.put.bind(hooks);
  // Inert persisted capability slots are replaced by local gatekeeper/gadget fakes below.
  let storedController = {} as BoundHookRecord["controller"];
  let storedCallback = {} as BoundHookRecord["callback"];
  let controller = { disable: async () => {} } as unknown as BoundHookRecord["controller"];
  let callback = {
    deliver: async (payload: string) => { deliveries.push(payload); },
  } as unknown as BoundHookRecord["callback"];
  put({
    id: 5, actionId: 999, gatekeeperId: TRACKED, vendorId: "trackedvendor", gadgetId,
    controller: storedController, callback: storedCallback, enabled: true,
    description: { title: "Hook", description: "Delivers events" },
  });
  hooks.get = (id: number) => {
    let record = get(id);
    return record && { ...record, controller, callback };
  };
  hooks.put = (record: BoundHookRecord) => put({
    ...record, controller: storedController, callback: storedCallback,
  });
  // The unit-test worker has no admin-config KV binding. Replace only that external read.
  let host = instance as unknown as { env: { BLUEPRINTS: { get(): Promise<null> } } };
  host.env = { ...host.env, BLUEPRINTS: { get: async () => null } };
  fakeFacets(impl);
  let firing = await instance.startHook(5);
  // The firing wrapper preserves the stored callback's deliver method across its RPC type.
  let deliveryCallback = firing.callback as unknown as { deliver(payload: string): Promise<void> };
  let client = await openFakeOverseer({ boundHooks: hooks, actions: impl.storage.actions }, {
    impl: { deleteHook: (id: number) => impl.deleteHook(id) },
  });
  return {
    approvalQueue: firing.approvalQueue,
    // Await once here: native RPC promises fork on each .then, including assertion handlers.
    deliver: async (payload: string) => { await deliveryCallback.deliver(payload); },
    deliveries,
    revoke: (operation: "disable" | "delete") => operation === "disable"
        ? client.disableHook(5) : client.deleteHook(5),
    [Symbol.dispose]() {
      firing.callback[Symbol.dispose]();
      (client as typeof client & Disposable)[Symbol.dispose]();
      hooks.get = get;
      hooks.put = put;
    },
  };
}

describe("tracked hook observations", () => {
  it.each([undefined, GADGET])(
      "delivers through the firing queue and records workspace requirements (hook gadgetId: %s)",
      gadgetId => withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    seedGadget(impl);
    addRows(impl, gadget(GADGET), TRACKED, ["gadget-only"]);
    for (let [profileId, role] of [["bob", "build"], ["carol", "use"]] as const) {
      world.roles.set(profileId, role);
      impl.storage.observers.put(
          { profileId, observerId: `obs-${profileId}`, accountChoices: { [TRACKED]: 20 } });
    }
    using firing = await startTrackedHook(world, gadgetId);
    let before = impl.storage.nextActionId.get();

    await firing.approvalQueue.authorizeObservation(observation({ subresources: ["hook/event"] }));
    await firing.deliver("evt");

    expect(firing.deliveries).toEqual(["evt"]);
    expect(world.checks).toHaveLength(2);
    for (let profileId of ["bob", "carol"]) {
      expect(world.checks).toContainEqual({ profileId, ids: ["hook/event"] });
    }
    expect(rows(impl, WORKSPACE)).toEqual(["2:hook/event"]);
    expect(rows(impl, gadget(GADGET))).toEqual(["2:gadget-only"]);
    expect(impl.storage.actions.get(before)).toMatchObject({
      gatekeeperId: TRACKED, type: "observation", state: "approved", caller: { from: "hook" },
      description: { subresources: ["hook/event"] },
    });
    expect(impl.storage.nextActionId.get()).toBe(before + 1);
  }));

  it.each(["build", "use"] as const)(
      "does not deliver or commit a read denied by a %s collaborator", role =>
      withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    world.roles.set("carol", role);
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [TRACKED]: 20 } });
    world.verifiers.set("carol", observerVerifier(() => world, "carol", ids => ids));
    using firing = await startTrackedHook(world);
    let before = impl.storage.nextActionId.get();
    let deliver = async () => {
      await firing.approvalQueue.authorizeObservation(observation({ subresources: ["denied"] }));
      await firing.deliver("evt");
    };

    await expect(deliver()).rejects.toThrow(/could not be confirmed/);

    expect(world.checks).toEqual([{ profileId: "carol", ids: ["denied"] }]);
    expect(firing.deliveries).toEqual([]);
    expect(rows(impl, WORKSPACE)).toEqual([]);
    expect(impl.storage.nextActionId.get()).toBe(before);
    expect(impl.storage.actions.get(before)).toBeUndefined();
  }));

  // Requirements stay in the log either way. A disabled or deleted hook no longer makes its
  // connection reachable from a "use" session, so as under the legacy protocol only "build"
  // collaborators are still verified against it.
  for (let operation of ["disable", "delete"] as const) {
    it.each(["build", "use"] as const)(
        `retains delivered hook requirements after ${operation} and a DO restart (%s admission)`,
        async role => {
      let name = `observer-ledger-hook-history-${++doCounter}`;
      let auditId = -1;
      await inOverseer(name, async world => {
        let { impl } = world;
        seedTracked(impl);
        using firing = await startTrackedHook(world);
        auditId = impl.storage.nextActionId.get();
        await firing.approvalQueue.authorizeObservation(observation({ subresources: ["past/event"] }));
        await firing.deliver("evt");
        expect(firing.deliveries).toEqual(["evt"]);
        await firing.revoke(operation);
        expect(impl.storage.boundHooks.get(5)?.enabled).not.toBe(true);
      });

      await abortAllDurableObjects();

      await inOverseer(name, async world => {
        let { impl } = world;
        fakeFacets(impl);
        world.roles.set("carol", role);
        world.verifiers.set("carol", observerVerifier(() => world, "carol", ids => ids));

        if (role === "build") {
          await expect(impl.ensureObserver("carol", world.clientUser("carol"), role, configureAll))
              .rejects.toThrow(/could not confirm/);
          expect(impl.storage.observers.get("carol")).toBeUndefined();
        } else {
          await impl.ensureObserver("carol", world.clientUser("carol"), role, configureAll);
          expect(world.checks).toEqual([]);
        }
        expect(rows(impl, WORKSPACE)).toEqual(["2:past/event"]);
        expect(impl.observerLedger.requiredSubresources(role).get(TRACKED)).toEqual(["past/event"]);
        expect(impl.storage.actions.get(auditId)).toMatchObject({
          caller: { from: "hook" }, description: { subresources: ["past/event"] },
        });
        expect(impl.storage.boundHooks.get(5)?.enabled).not.toBe(true);
      });
    });
  }

  it.each(["disable", "delete", "restart"] as const)(
      "refuses authorization and policy/log writes when %s races verification", operation =>
      withWorld(async world => {
      let { impl } = world;
      seedTracked(impl);
      world.roles.set("carol", "use");
      impl.storage.observers.put(
          { profileId: "carol", observerId: "obs-c", accountChoices: { [TRACKED]: 20 } });
      let release!: () => void;
      let reached!: () => void;
      let parked = new Promise<void>(resolve => { release = resolve; });
      let checking = new Promise<void>(resolve => { reached = resolve; });
      world.verifiers.set("carol", observerVerifier(() => world, "carol", async () => {
        reached();
        await parked;
        return [];
      }));
      using firing = await startTrackedHook(world);
      let before = impl.storage.nextActionId.get();
      let authorize = firing.approvalQueue.authorizeObservation(observation({
        subresources: ["racing/event"], containsRestrictedData: true, ownerInvitesOnly: true,
      })).then(() => ({ authorized: true, error: "" }),
          error => ({ authorized: false, error: String(error) }));
      await checking;
      let refusal = operation === "restart" ? /restarting/ : /deleted or disabled/;
      if (operation === "restart") {
        // Exercise the real pending-restart quarantine without letting its timer abort this DO.
        impl.scheduleAccessRestart = () => {};
        let leave = impl.joinSession("use");
        impl.restartForObserverTracking("connection changed during hook verification", TRACKED);
        leave();
        expect(impl.gatekeeperUsable(TRACKED)).toBe(false);
      } else {
        await firing.revoke(operation);
      }
      release();

      expect(await authorize).toEqual({
        authorized: false, error: expect.stringMatching(refusal),
      });
      await expect(firing.deliver("evt")).rejects.toThrow(refusal);
      expect(firing.deliveries).toEqual([]);
      expect(rows(impl, WORKSPACE)).toEqual([]);
      expect(impl.storage.nextActionId.get()).toBe(before);
      expect(impl.storage.actions.get(before)).toBeUndefined();
      expect(impl.storage.containsRestrictedData.get()).toBe(false);
      expect(impl.storage.ownerInvitesOnly.get()).toBe(false);
    }));
});

describe("legacy and tracked connections coexist", () => {
  it("verifies each by its own protocol and keeps the legacy exclusion path", () =>
      withWorld(async world => {
    let { impl } = world;
    seedLegacy(impl);
    seedTracked(impl);
    addRows(impl, WORKSPACE, TRACKED, ["a"]);
    let adds: number[] = [];
    fakeFacets(impl, { adds });
    world.roles.set("carol", "build");

    await impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll);

    // The legacy connection registered her; the tracked one was checked statelessly instead.
    expect(adds).toEqual([LEGACY]);
    expect(world.checks).toEqual([{ profileId: "carol", ids: ["a"] }]);
    let record = impl.storage.observers.get("carol");
    expect(record.accountChoices).toEqual({ [LEGACY]: 10, [TRACKED]: 20 });

    // The legacy connection still names observers to exclude, and is still blocked by them.
    await expect(impl.authorizeObservation(LEGACY,
        observation({ excludeObservers: [record.observerId] }), { from: "user" }))
        .rejects.toThrow(/not permitted to see/);
    // A tracked one may not mix the two.
    await expect(impl.authorizeObservation(TRACKED,
        observation({ subresources: [], excludeObservers: [record.observerId] }),
        { from: "user" }))
        .rejects.toThrow(/cannot exclude observers/);
  }));

  it("does not treat an advertised flag as a completed import", () => withWorld(async world => {
    let { impl } = world;
    seedLegacy(impl);
    fakeFacets(impl, { advertise: new Set([LEGACY]) });
    let before = impl.storage.nextActionId.get();
    // A session minted before the Workshop noticed the upgrade reports IDs: refused, not
    // silently recorded or dropped.
    await expect(impl.authorizeObservation(LEGACY, observation({ subresources: ["x"] }),
        { from: "user" }))
        .rejects.toThrow(/must be set up/);
    expect(impl.observerLedger.isTracked(LEGACY)).toBe(false);
    expect(impl.storage.nextActionId.get()).toBe(before);
  }));
});

describe("observations through a tracked connection", () => {
  it("accept an explicit [] and refuse omitted IDs", () => withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    let before = impl.storage.nextActionId.get();

    await impl.authorizeObservation(TRACKED, observation({ subresources: [] }), { from: "user" });
    expect(impl.storage.nextActionId.get()).toBe(before + 1);  // audited
    expect(rows(impl, WORKSPACE)).toEqual([]);

    await expect(impl.authorizeObservation(TRACKED, observation(), { from: "user" }))
        .rejects.toThrow(/must report its subresources/);
    expect(impl.storage.nextActionId.get()).toBe(before + 1);
  }));

  it.each([
    ["a denial", () => ({ denied: ["x"] })],
    ["missing denied IDs", () => ({})],
    ["non-array denied IDs", () => ({ denied: "x" })],
    ["sparse denied IDs", () => ({ denied: new Array(1) })],
    ["non-string denied IDs", () => ({ denied: [false] })],
    ["an unwrapped array", () => []],
    ["a failed verification", () => { throw new Error("provider down"); }],
  ])("fail closed on %s from an admitted observer's verifier", (_name, answer) =>
      withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    let registrations: number[] = [];
    fakeFacets(impl, { adds: registrations });
    world.roles.set("carol", "use");
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [TRACKED]: 20 } });
    world.verifiers.set("carol", { verifyObserverAccess: async () => answer() });
    let before = impl.storage.nextActionId.get();

    await expect(impl.authorizeObservation(TRACKED, observation({ subresources: ["x", "y"] }),
        { from: "user" }))
        .rejects.toThrow(/could not be confirmed/);
    expect(rows(impl, WORKSPACE)).toEqual([]);
    expect(impl.storage.nextActionId.get()).toBe(before);
    expect(registrations).toEqual([]);
  }));

  it("check configured observers who are offline, but not ones who lost access", () =>
      withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    world.roles.set("carol", "build");
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [TRACKED]: 20 } });
    impl.storage.observers.put(
        { profileId: "erin", observerId: "obs-e", accountChoices: { [TRACKED]: 21 } });
    // Erin is configured but no longer in the sharing graph; her denial must not block anything.
    world.verifiers.set("erin", observerVerifier(() => world, "erin", ids => ids));

    await impl.authorizeObservation(TRACKED, observation({ subresources: ["x"] }),
        { from: "user" });
    expect(world.checks).toEqual([{ profileId: "carol", ids: ["x"] }]);
    expect(rows(impl, WORKSPACE)).toEqual(["2:x"]);

    // A remembered ID is not a remembered grant: the next read checks it again.
    await impl.authorizeObservation(TRACKED, observation({ subresources: ["x"] }),
        { from: "user" });
    expect(world.checks).toHaveLength(2);
  }));

  it("does not admit a collaborator alongside an unreadable concurrent observation", () =>
      withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    fakeFacets(impl);
    world.roles.set("carol", "build");
    let sharing = await impl.getSharingManager();
    impl.getSharingManager = async () => {
      // Let the read's final audience snapshot race with admission's final history check.
      for (let i = 0; i < 3; i++) await Promise.resolve();
      return sharing;
    };
    let read: Promise<boolean> | undefined;
    let clientUser = {
      ...world.clientUser("carol"),
      getVerifier: () => {
        read ??= impl.authorizeObservation(TRACKED, observation({ subresources: ["x"] }),
            { from: "user" }).then(() => true, () => false);
        return Promise.resolve(observerVerifier(() => world, "carol", ids => ids));
      },
    };
    let admitted = await impl.ensureObserver("carol", clientUser, "build", configureAll)
        .then(() => true, () => false);
    expect(read).toBeDefined();
    let authorized = await read;
    if (admitted) {
      expect(authorized).toBe(false);
      expect(rows(impl, WORKSPACE)).toEqual([]);
    } else {
      expect(authorized).toBe(true);
      expect(rows(impl, WORKSPACE)).toEqual(["2:x"]);
      expect(impl.storage.observers.get("carol")).toBeUndefined();
    }
    expect(world.checks).toContainEqual({ profileId: "carol", ids: ["x"] });
  }));

  it.each([true, false])(
      "rechecks a replacement account before publishing (replacement readable: %s)", readable =>
      withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    world.roles.set("carol", "build");
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [TRACKED]: 20 } });
    let release!: () => void;
    let reached!: () => void;
    let parked = new Promise<void>(resolve => { release = resolve; });
    let checking = new Promise<void>(resolve => { reached = resolve; });
    let accounts: number[] = [];
    world.clientUser = (profileId: string) => ({
      getVerifier: async (accountId: number) => {
        accounts.push(accountId);
        return observerVerifier(() => world, profileId, async ids => {
          if (accountId === 20) {
            reached();
            await parked;
          }
          return accountId === 20 || readable ? [] : ids;
        });
      },
    });
    let before = impl.storage.nextActionId.get();
    let read = impl.authorizeObservation(TRACKED, observation({ subresources: ["x"] }),
        { from: "user" });
    await checking;
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [TRACKED]: 21 } });
    release();

    if (readable) await read;
    else await expect(read).rejects.toThrow(/could not be confirmed/);
    expect(accounts).toEqual([20, 21]);
    expect(rows(impl, WORKSPACE)).toEqual(readable ? ["2:x"] : []);
    expect(impl.storage.nextActionId.get()).toBe(before + (readable ? 1 : 0));
    if (!readable) expect(impl.storage.actions.get(before)).toBeUndefined();
  }));
});

describe("admission against tracked requirements", () => {
  it.each(["build", "use"] as const)(
      "admits %s collaborators against workspace and every reachable context", role =>
      withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    seedGadget(impl, GADGET, { C: TRACKED });
    seedGadget(impl, GADGET + 1);
    addRows(impl, WORKSPACE, TRACKED, ["workspace"]);
    addRows(impl, chat(1), TRACKED, ["chat-one"]);
    addRows(impl, chat(2), TRACKED, ["chat-two"]);
    addRows(impl, gadget(GADGET), TRACKED, ["gadget-one"]);
    addRows(impl, gadget(GADGET + 1), TRACKED, ["gadget-two"]);
    fakeFacets(impl);
    world.roles.set("carol", role);
    world.verifiers.set("carol", observerVerifier(() => world, "carol",
        ids => ids.filter(id => role !== "build" && id.startsWith("chat-"))));

    await impl.ensureObserver("carol", world.clientUser("carol"), role, configureAll);

    let expected = ["workspace", "gadget-one", "gadget-two"];
    if (role === "build") expected.push("chat-one", "chat-two");
    expect(world.checks.map(check => ({ ...check, ids: check.ids.toSorted() }))).toEqual([
      { profileId: "carol", ids: expected.toSorted() },
    ]);
    expect(impl.storage.observers.get("carol").accountChoices).toEqual({ [TRACKED]: 20 });
  }));

  it.each([
    ["a denied resource", { verifyObserverAccess: async () => ({ denied: ["a"] }) }],
    ["missing denied IDs", { verifyObserverAccess: async () => ({}) }],
    ["non-array denied IDs", { verifyObserverAccess: async () => ({ denied: "a" }) }],
    ["sparse denied IDs", { verifyObserverAccess: async () => ({ denied: new Array(1) }) }],
    ["non-string denied IDs", { verifyObserverAccess: async () => ({ denied: [false] }) }],
    ["an unwrapped result", { verifyObserverAccess: async () => [] }],
    ["a missing method", {}],
    ["a wrong vendor or failed lookup", new Error("Invalid account selection for this service.")],
    ["a failed check", { verifyObserverAccess: async () => { throw new Error("expired"); } }],
  ])("fails closed on %s, with no legacy fallback", (_name, verifier) =>
      withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    addRows(impl, WORKSPACE, TRACKED, ["a"]);
    let adds: number[] = [];
    fakeFacets(impl, { adds });
    world.roles.set("carol", "build");
    world.verifiers.set("carol", verifier);
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [TRACKED]: 20 } });

    await expect(impl.ensureObserver("carol", world.clientUser("carol"), "build"))
        .rejects.toThrow(/could not confirm/);
    expect(adds).toEqual([]);  // never handed to the facet's addObserver
  }));

  it("admits collaborators after observed legacy connections are removed", () =>
      withWorld(async world => {
    let { impl } = world;
    seedLegacy(impl, 5);
    seedLegacy(impl, LEGACY);
    seedTracked(impl);
    addRows(impl, WORKSPACE, TRACKED, ["still-live"]);
    let adds: number[] = [];
    fakeFacets(impl, { adds });
    world.roles.set("carol", "build");
    impl.removeGatekeeper(5);

    await impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll);

    expect(adds).toEqual([LEGACY]);
    expect(world.checks).toEqual([{ profileId: "carol", ids: ["still-live"] }]);
    expect(impl.storage.observers.get("carol").accountChoices).toEqual({
      [LEGACY]: 10, [TRACKED]: 20,
    });
  }));

  it("re-verifies when a requirement lands while the account prompt is open", () =>
      withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    addRows(impl, WORKSPACE, TRACKED, ["a"]);
    fakeFacets(impl);
    world.roles.set("carol", "build");

    let release!: () => void;
    let prompted!: () => void;
    let promptOpen = new Promise<void>(resolve => { prompted = resolve; });
    let parked = new Promise<void>(resolve => { release = resolve; });
    let configureCb = {
      configure: async (needs: { gatekeeperId: number }[]) => {
        prompted();
        await parked;
        return configureAll.configure(needs);
      },
    };
    let admission = impl.ensureObserver("carol", world.clientUser("carol"), "build", configureCb);
    await promptOpen;

    // The owner reads more while Carol chooses an account; she is not an observer yet, so the
    // read is not checked against her -- her admission must pick it up instead.
    await impl.authorizeObservation(TRACKED, observation({ subresources: ["b"] }),
        { from: "user" });
    expect(world.checks).toEqual([]);
    release();
    await admission;

    expect(world.checks.at(-1)).toEqual({ profileId: "carol", ids: ["a", "b"] });
    expect(impl.storage.observers.get("carol").accountChoices).toEqual({ [TRACKED]: 20 });
  }));

  it("blocks an in-flight observation that a newly admitted collaborator cannot access", () =>
      withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    world.roles.set("carol", "build");
    world.roles.set("dave", "build");
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [TRACKED]: 20 } });
    let release!: () => void;
    let parked = new Promise<void>(resolve => { release = resolve; });
    let reached!: () => void;
    let checking = new Promise<void>(resolve => { reached = resolve; });
    world.verifiers.set("carol", observerVerifier(() => world, "carol", async () => {
      reached();
      await parked;
      return [];
    }));
    world.verifiers.set("dave", observerVerifier(() => world, "dave", ids => ids));
    let before = impl.storage.nextActionId.get();

    let read = impl.authorizeObservation(TRACKED, observation({ subresources: ["x"] }),
        { from: "user" });
    await checking;
    // Dave's admission publishes while Carol's check is in flight.
    impl.storage.observers.put(
        { profileId: "dave", observerId: "obs-d", accountChoices: { [TRACKED]: 30 } });
    release();
    await expect(read).rejects.toThrow(/could not be confirmed/);
    expect(rows(impl, WORKSPACE)).toEqual([]);
    expect(impl.storage.nextActionId.get()).toBe(before);
    expect(impl.storage.actions.get(before)).toBeUndefined();
  }));

  it("asks use collaborators for no account for a connection nothing binds or hooks", () =>
      withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    addRows(impl, chat(1), TRACKED, ["chat-only"]);
    fakeFacets(impl);
    world.roles.set("carol", "use");
    world.roles.set("dave", "build");
    let asked: number[][] = [];
    // A direct-DO double supplying only the RPC method admission calls.
    let configure = {
      configure: async (needs: { gatekeeperId: number }[]) => {
        asked.push(needs.map(need => need.gatekeeperId));
        return needs.map(need => ({ gatekeeperId: need.gatekeeperId, accountId: need.gatekeeperId * 10 }));
      },
    } as unknown as NonNullable<Parameters<ObserverImpl["ensureObserver"]>[3]>;

    await impl.ensureObserver("carol", world.clientUser("carol"), "use", configure);
    expect(asked).toEqual([]);
    expect(world.checks).toEqual([]);

    await impl.ensureObserver("dave", world.clientUser("dave"), "build", configure);
    expect(asked).toEqual([[TRACKED]]);
    expect(world.checks).toEqual([{ profileId: "dave", ids: ["chat-only"] }]);
  }));
});

describe("historical import", () => {
  it("rediscovers a legacy connection's upgrade before admitting a collaborator", () =>
      withWorld(async world => {
    let { impl } = world;
    seedLegacy(impl);
    let advertise = new Set<number>();
    let adds: number[] = [];
    fakeFacets(impl, {
      advertise, adds,
      exports: new Map([[LEGACY, async () => ["restricted/history"]]]),
    });
    await impl.observerLedger.initialize(LEGACY);
    advertise.add(LEGACY);
    world.verifiers.set("carol", observerVerifier(() => world, "carol", ids => ids));

    await expect(impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll))
        .rejects.toThrow(/could not confirm/);
    expect(impl.storage.observers.get("carol")).toBeUndefined();
    expect(adds).toEqual([]);
    expect(rows(impl, WORKSPACE)).toEqual(["1:restricted/history"]);

    world.verifiers.delete("carol");
    await impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll);
    expect(impl.storage.observers.get("carol").accountChoices).toEqual({ [LEGACY]: 10 });
  }));

  it.each([false, true])(
      "denies admission on failed upgrade discovery and retries (previously initialized: %s)",
      initialized => withWorld(async world => {
    let { impl } = world;
    seedLegacy(impl);
    let adds: number[] = [];
    fakeFacets(impl, { adds });
    if (initialized) await impl.observerLedger.initialize(LEGACY);
    let fail = true;
    let getFacet = impl.getGatekeeperFacet;
    impl.getGatekeeperFacet = async (id: number) => ({
      ...await getFacet(id),
      describe: async () => {
        if (fail) throw new Error("Discovery unavailable");
        return { supportsObserverTracking: true };
      },
      getHistoricalSubresources: async () => ["restricted/history"],
    });

    await expect(impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll))
        .rejects.toThrow(/could not confirm/);
    expect(impl.storage.observers.get("carol")).toBeUndefined();
    expect(adds).toEqual([]);

    fail = false;
    world.verifiers.set("carol", observerVerifier(() => world, "carol", ids => ids));
    await expect(impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll))
        .rejects.toThrow(/could not confirm/);
    expect(impl.storage.observers.get("carol")).toBeUndefined();
    expect(adds).toEqual([]);
    expect(rows(impl, WORKSPACE)).toEqual(["1:restricted/history"]);
  }));

  it("imports an existing legacy connection that starts advertising, even with no prior reads", () =>
      withWorld(async world => {
    let { impl } = world;
    seedLegacy(impl);
    let exports = 0;
    fakeFacets(impl, {
      advertise: new Set([LEGACY]),
      exports: new Map([[LEGACY, async () => { exports++; return []; }]]),
    });
    let before = impl.storage.nextActionId.get();

    await impl.observerLedger.initialize(LEGACY);
    expect(impl.observerLedger.isTracked(LEGACY)).toBe(true);
    expect(exports).toBe(1);
    // An empty export writes no audit record.
    expect(impl.storage.nextActionId.get()).toBe(before);
    expect(rows(impl, WORKSPACE)).toEqual([]);
    world.roles.set("carol", "build");
    await impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll);
    await impl.authorizeObservation(LEGACY, observation({ subresources: ["first-real-read"] }),
        { from: "user" });
    expect(world.checks).toEqual([
      { profileId: "carol", ids: ["first-real-read"] },
    ]);
    expect(rows(impl, WORKSPACE)).toEqual(["1:first-real-read"]);
  }));

  it("exports once for concurrent first callers and merges into the workspace context", () =>
      withWorld(async world => {
    let { impl } = world;
    seedLegacy(impl, 3);
    let exports = 0;
    fakeFacets(impl, {
      advertise: new Set([3]),
      exports: new Map([[3, async () => { exports++; return ["p1", "p1", "p2"]; }]]),
    });

    let before = impl.storage.nextActionId.get();
    await Promise.all([impl.observerLedger.initialize(3), impl.observerLedger.initialize(3)]);
    expect(exports).toBe(1);
    expect(impl.observerLedger.isTracked(3)).toBe(true);
    // One workspace audit record carries the whole (deduplicated) export.
    expect(impl.storage.nextActionId.get()).toBe(before + 1);
    expect(impl.storage.actions.get(before)).toMatchObject({
      gatekeeperId: 3, type: "observation", caller: { from: "user" },
      description: { title: "Imported earlier reads", subresources: ["p1", "p2"] },
    });
    // Every context, existing or future, includes workspace requirements.
    expect(impl.observerLedger.requiredSubresources("use").get(3)).toEqual(["p1", "p2"]);
  }));

  it("imports history larger than one observation and checks every verification batch", () =>
      withWorld(async world => {
    let { impl } = world;
    seedLegacy(impl);
    let ids = Array.from({ length: 10_001 }, (_, i) => String(i));
    fakeFacets(impl, {
      advertise: new Set([LEGACY]),
      exports: new Map([[LEGACY, async () => ids]]),
    });
    await impl.observerLedger.initialize(LEGACY);
    expect(impl.observerLedger.requiredSubresources("build").get(LEGACY)).toEqual(ids);
    world.roles.set("carol", "build");
    world.verifiers.set("carol", observerVerifier(() => world, "carol",
        batch => batch.filter(id => id === ids.at(-1))));
    await expect(impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll))
        .rejects.toThrow(/could not confirm/);
    expect(world.checks).toContainEqual({ profileId: "carol", ids: ids.slice(10_000) });
    expect(impl.storage.observers.get("carol")).toBeUndefined();
    await expect(impl.authorizeObservation(LEGACY, observation({ subresources: ids }),
        { from: "user" })).rejects.toThrow(/at most 10000/);
    expect(impl.observerLedger.requiredSubresources("build").get(LEGACY)).toEqual(ids);
    world.verifiers.delete("carol");
    await impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll);
    expect(impl.storage.observers.get("carol").accountChoices).toEqual({ [LEGACY]: 10 });
  }));

  it("retries after a failure before the commit, and never after it", async () => {
    let name = `observer-ledger-import-${++doCounter}`;
    let exports = 0;
    let fail = true;
    let facets = (impl: any) => fakeFacets(impl, {
      advertise: new Set([3]),
      exports: new Map([[3, async () => {
        exports++;
        if (fail) throw new Error("export interrupted");
        return ["p1"];
      }]]),
    });
    await inOverseer(name, async ({ impl }) => {
      seedLegacy(impl, 3);
      facets(impl);
      await expect(impl.observerLedger.initialize(3)).rejects.toThrow(/export interrupted/);
      // A failed export never clears workspace requirements, and leaves the connection legacy.
      expect(impl.observerLedger.isTracked(3)).toBe(false);
      expect(rows(impl, WORKSPACE)).toEqual([]);

      fail = false;
      await impl.observerLedger.initialize(3);
      expect(exports).toBe(2);
    });

    await abortAllDurableObjects();

    await inOverseer(name, async ({ impl }) => {
      facets(impl);
      await impl.observerLedger.initialize(3);
      expect(exports).toBe(2);  // completion is durable: the stored history is authoritative
      expect(rows(impl, WORKSPACE)).toEqual(["3:p1"]);
    });
  });

  it("refuses legacy hook queues while their historical import is parked", () =>
      withWorld(async world => {
    let { impl } = world;
    seedLegacy(impl);
    let release!: () => void;
    let reached!: () => void;
    let parked = new Promise<void>(resolve => { release = resolve; });
    let exporting = new Promise<void>(resolve => { reached = resolve; });
    fakeFacets(impl, {
      advertise: new Set([LEGACY]),
      exports: new Map([[LEGACY, async () => {
        reached();
        await parked;
        return ["history"];
      }]]),
    });
    let before = impl.storage.nextActionId.get();
    let importing = impl.observerLedger.initialize(LEGACY);
    await exporting;

    await expect(impl.authorizeObservation(LEGACY, observation(), { from: "hook" }))
        .rejects.toThrow(/being migrated/);
    expect(rows(impl, WORKSPACE)).toEqual([]);
    expect(impl.storage.nextActionId.get()).toBe(before);
    expect(impl.storage.actions.get(before)).toBeUndefined();
    expect(impl.observerLedger.isTracked(LEGACY)).toBe(false);

    release();
    await importing;
    expect(rows(impl, WORKSPACE)).toEqual(["1:history"]);
  }));

  it("refuses a legacy observation imported while its policy lookup was in flight", () =>
      withWorld(async world => {
    let { impl } = world;
    seedLegacy(impl);
    fakeFacets(impl, { advertise: new Set([LEGACY]) });
    let release!: () => void;
    let reached!: () => void;
    let parked = new Promise<void>(resolve => { release = resolve; });
    let lookingUp = new Promise<void>(resolve => { reached = resolve; });
    let sharing = await impl.getSharingManager();
    impl.getSharingManager = async () => {
      reached();
      await parked;
      return sharing;
    };
    let before = impl.storage.nextActionId.get();
    let read = impl.authorizeObservation(LEGACY,
        observation({ ownerInvitesOnly: true, containsRestrictedData: true }), { from: "hook" });
    await lookingUp;
    await impl.observerLedger.initialize(LEGACY);
    release();

    await expect(read).rejects.toThrow(/must report its subresources/);
    expect(impl.storage.nextActionId.get()).toBe(before);
    expect(impl.storage.actions.get(before)).toBeUndefined();
    expect(impl.storage.ownerInvitesOnly.get()).toBe(false);
    expect(impl.storage.containsRestrictedData.get()).toBe(false);
  }));

  it("refuses a legacy exclusion check that the import overtakes", () => withWorld(async world => {
    let { impl } = world;
    seedLegacy(impl);
    fakeFacets(impl, { advertise: new Set([LEGACY]) });
    let release!: () => void;
    let reached!: () => void;
    let parked = new Promise<void>(resolve => { release = resolve; });
    let excluding = new Promise<void>(resolve => { reached = resolve; });
    let sharing = await impl.getSharingManager();
    impl.getSharingManager = async () => {
      reached();
      await parked;
      return sharing;
    };
    let before = impl.storage.nextActionId.get();
    let read = impl.authorizeObservation(LEGACY,
        observation({ excludeObservers: ["obs-unknown"] }), { from: "user" });
    await excluding;
    await impl.observerLedger.initialize(LEGACY);
    release();

    await expect(read).rejects.toThrow(/must report its subresources/);
    expect(impl.storage.nextActionId.get()).toBe(before);
  }));

  it("is skipped for a connection created already advertising support", () =>
      withWorld(async world => {
    let { impl } = world;
    let exports = 0;
    fakeFacets(impl, { exports: new Map() });
    let describe = async () => ({
      url: "https://example.com/new", title: "New", snippet: "", suggestedBindingName: "N",
      tsType: "N", supportsObserverTracking: true,
    });
    impl.getGatekeeperFacet = async () => ({
      describe, getHistoricalSubresources: async () => { exports++; return ["old"]; },
    });

    await impl.addGatekeeper({} as any, spec("trackedvendor", 9), "owner");
    let id = [...impl.storage.gatekeepers.list()][0].id;
    await impl.observerLedger.initialize(id);
    expect(impl.observerLedger.isTracked(id)).toBe(true);
    expect(impl.storage.gatekeepers.get(id).observerTracking).toBe(true);
    expect(exports).toBe(0);
    expect(rows(impl, WORKSPACE)).toEqual([]);
  }));

  it("audits simulated reads without external permissions, then checks the approved real resource", () =>
      withWorld(async world => {
    let { impl } = world;
    impl.ownerId = "owner";
    impl.traceAgentActionApproval = () => {};
    impl.wrapUserDo = (user: unknown) => user;
    let restarts: string[] = [];
    impl.scheduleAccessRestart = (reason: string) => { restarts.push(reason); };
    let sharing = await impl.getSharingManager();
    impl.getSharingManager = async () => ({
      ...sharing, computeAffectedByOwnerInvitesOnly: () => [],
    });
    impl.users = {
      idFromName: (id: string) => id,
      idFromString: (id: string) => id,
      get: (id: string) => ({
        ...world.clientUser(id),
        createResourceGatekeeper: async () => ({
          class: {}, typeUrlPattern: "https://example.com/*",
          action: { title: "Create", description: "Create", implementsRevert: false },
        }),
      }),
    };
    let real = false;
    let exports = 0;
    impl.getGatekeeperFacet = async () => ({
      describe: async () => ({
        url: `https://example.com/${real ? "real" : "simulated"}`,
        title: real ? "Real" : "Simulated", snippet: "", suggestedBindingName: "N", tsType: "N",
        supportsObserverTracking: true,
      }),
      getHistoricalSubresources: async () => { exports++; return []; },
      applyCreation: async () => {
        real = true;
        return { class: {}, resourceUrl: "https://example.com/real" };
      },
      startSession: async (queue: ObservationAuthorizer) => ({
        read: (description: ObservationDescription) => queue.authorizeObservation(description),
      }),
    });

    let leave = impl.joinSession("build");
    try {
      let { gatekeeperId } = await impl.createExternalResource(1, {
        vendorId: "trackedvendor", resourceUrlPattern: "https://example.com/*", title: "New",
        bindingName: "N",
      });
      await impl.observerLedger.initialize(gatekeeperId);
      let session = await impl.openGatekeeperSession(gatekeeperId, { from: "user" });
      let before = impl.storage.nextActionId.get();
      await session.read(observation({
        subresources: ["simulated-id"], containsRestrictedData: true, ownerInvitesOnly: true,
      }));
      expect(impl.storage.actions.get(before)).toMatchObject({
        gatekeeperId, type: "observation", state: "approved",
      });
      expect(impl.storage.actions.get(before).description.subresources).toBeUndefined();
      expect(impl.storage.nextActionId.get()).toBe(before + 1);
      expect(impl.storage.ownerInvitesOnly.get()).toBe(true);
      expect(() => impl.getWebFetchEnv()).toThrow(/observed sensitive data/);
      expect(impl.storage.gatekeepers.get(gatekeeperId).observerTracking).toBeUndefined();
      expect([...impl.storage.actions.byObserverContext.list()]).toEqual([]);
      for (let role of ["build", "use"] as const) {
        expect(impl.listObserverRequirements(role)).toEqual([]);
        await impl.ensureObserver("carol", world.clientUser("carol"), role);
      }
      expect(world.checks).toEqual([]);
      expect(exports).toBe(0);
      expect(restarts).toEqual([]);
      expect(impl.gatekeeperUsable(gatekeeperId)).toBe(true);

      // Let the simulated collaborator session close so approval can be exercised in this DO
      // without its normal access restart quarantining the real connection until a reset.
      leave();
      let [creation] = impl.storage.actions.pendingByGatekeeper.get(gatekeeperId);
      await impl.applyPendingAction(creation,
          { type: "user", id: "owner", name: "Owner" }, false,
          { creator: {}, configuration: null });
      expect(impl.storage.actions.get(creation.id).state).toBe("approved");
      let realSession = await impl.openGatekeeperSession(gatekeeperId, { from: "user" });
      expect([...impl.storage.gatekeepers.list()].map((record: GatekeeperRecord) => record.id))
          .toEqual([gatekeeperId]);
      expect(impl.storage.gatekeepers.get(gatekeeperId)).toMatchObject({
        id: gatekeeperId, observerTracking: true,
        creationSpec: { resourceUrl: "https://example.com/real" },
      });
      // Approval makes it an existing connection advertising support: imported exactly once.
      expect(exports).toBe(1);
      expect(rows(impl, WORKSPACE)).toEqual([]);

      world.roles.set("carol", "build");
      await impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll);
      world.verifiers.set("carol", observerVerifier(() => world, "carol", ids => ids));
      let beforeDenied = impl.storage.nextActionId.get();
      await expect(realSession.read(observation({ subresources: ["real-id"] })))
          .rejects.toThrow(/could not be confirmed/);
      expect(impl.storage.nextActionId.get()).toBe(beforeDenied);
      expect(rows(impl, WORKSPACE)).toEqual([]);
      world.verifiers.delete("carol");
      await realSession.read(observation({ subresources: ["real-id"] }));
      expect(world.checks).toEqual([
        { profileId: "carol", ids: ["real-id"] },
        { profileId: "carol", ids: ["real-id"] },
      ]);
      expect(rows(impl, WORKSPACE)).toEqual([`${gatekeeperId}:real-id`]);
      expect(exports).toBe(1);
    } finally {
      leave();
    }
  }));

  it("refuses a tracked connection that stops advertising support", () =>
      withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    impl.getGatekeeperFacet = async () => ({
      describe: async () => ({ url: "u", title: "T", snippet: "", suggestedBindingName: "N",
                               tsType: "N" }),
    });
    await expect(impl.observerLedger.initialize(TRACKED)).rejects.toThrow(/stopped supporting/);
  }));

  it("verifies fully qualified historical and new IDs without conflating same-named resources", () =>
      withWorld(async world => {
    let { impl } = world;
    let first = "workspace-a/documents/shared";
    let second = "workspace-b/documents/shared";
    seedTracked(impl);
    seedLegacy(impl, 3, { creationSpec: spec("trackedvendor", 3) });
    addRows(impl, WORKSPACE, TRACKED, [first]);
    fakeFacets(impl, {
      advertise: new Set([3]),
      exports: new Map([[3, async () => [second]]]),
    });
    await impl.observerLedger.initialize(3);
    world.roles.set("carol", "build");
    world.verifiers.set("carol", observerVerifier(() => world, "carol",
        ids => ids.filter(id => id !== first)));

    await expect(impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll))
        .rejects.toThrow(/could not confirm/);
    expect(world.checks.some(check => check.ids.includes(second))).toBe(true);
    expect(impl.storage.observers.get("carol")).toBeUndefined();
    expect(rows(impl, WORKSPACE)).toEqual([`2:${first}`, `3:${second}`]);

    world.verifiers.delete("carol");
    await impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll);
    expect(impl.storage.observers.get("carol").accountChoices).toEqual({ 2: 20, 3: 30 });

    // A grant for this leaf name in workspace A cannot authorize a read in workspace B.
    world.verifiers.set("carol", observerVerifier(() => world, "carol",
        ids => ids.filter(id => id !== first)));
    let before = impl.storage.nextActionId.get();
    await expect(impl.authorizeObservation(TRACKED, observation({ subresources: [second] }),
        { from: "user" })).rejects.toThrow(/could not be confirmed/);
    expect(world.checks.at(-1)).toEqual({ profileId: "carol", ids: [second] });
    expect(rows(impl, WORKSPACE)).toEqual([`2:${first}`, `3:${second}`]);
    expect(impl.storage.nextActionId.get()).toBe(before);
  }));
});

describe("connection removal", () => {
  it.each(["build", "use"] as const)(
      "drops the connection's requirements across every context but keeps its audit history for %s admission after restart",
      async role => {
    let name = `observer-ledger-removal-${++doCounter}`;
    let auditId = -1;
    let liveAuditId = -1;
    await inOverseer(name, async ({ impl }) => {
      seedTracked(impl);
      seedTracked(impl, 3);
      seedGadget(impl);
      auditId = impl.storage.nextActionId.get();
      await impl.authorizeObservation(TRACKED,
          observation({ title: "Retained read", subresources: ["removed/first"] }),
          { from: "user" });
      liveAuditId = impl.storage.nextActionId.get();
      await impl.authorizeObservation(3, observation({ subresources: ["live/workspace"] }),
          { from: "user" });
      for (let context of [WORKSPACE, chat(1), chat(99), gadget(GADGET), gadget(999)]) {
        addRows(impl, context, TRACKED, ["removed/read"]);
        addRows(impl, context, 3, ["live/read"]);
      }
      impl.bindWorkpiece(GADGET, "REMOVED", TRACKED);
      impl.bindWorkpiece(GADGET, "LIVE", 3);

      impl.removeGatekeeper(TRACKED);

      expect(impl.storage.gatekeepers.get(TRACKED)).toBeUndefined();
      expect(impl.storage.gatekeepers.get(3).observerTracking).toBe(true);
      expect(impl.observerLedger.requiredSubresources("build"))
          .toEqual(new Map([[3, ["live/workspace", "live/read"]]]));
      // The removed connection's records stay in the audit log.
      for (let context of [chat(1), chat(99), gadget(GADGET), gadget(999)]) {
        expect(rows(impl, context)).toEqual(["2:removed/read", "3:live/read"]);
      }
      expect(impl.storage.gadgets.get(GADGET).bindings).toEqual({ LIVE: { target: 3 } });
      expect(impl.storage.actions.get(auditId)).toMatchObject({
        gatekeeperId: TRACKED, type: "observation", state: "approved",
        description: { title: "Retained read", subresources: ["removed/first"] },
      });
      expect(impl.storage.actions.get(liveAuditId).gatekeeperId).toBe(3);
    });

    await abortAllDurableObjects();

    await inOverseer(name, async world => {
      let { impl } = world;
      fakeFacets(impl);
      world.roles.set("carol", role);
      world.verifiers.set("carol", observerVerifier(() => world, "carol",
          ids => ids.filter(id => !id.startsWith("live/"))));

      await impl.ensureObserver("carol", world.clientUser("carol"), role, configureAll);

      expect(world.checks).toEqual([
        { profileId: "carol", ids: ["live/workspace", "live/read"] },
      ]);
      expect(impl.listObserverRequirements(role)
          .map((need: { gatekeeperId: number }) => need.gatekeeperId))
          .toEqual([3]);
      expect(impl.storage.observers.get("carol").accountChoices).toEqual({ 3: 30 });
      expect(impl.storage.gatekeepers.get(TRACKED)).toBeUndefined();
      expect(impl.storage.actions.get(auditId)).toMatchObject({
        gatekeeperId: TRACKED, description: { subresources: ["removed/first"] },
      });
      expect(impl.storage.actions.get(liveAuditId).gatekeeperId).toBe(3);
    });
  });
});

describe("direct context authorization", () => {
  it("records chat reads only in that chat and checks build, not use, collaborators", () =>
      withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    seedGadget(impl);
    addRows(impl, WORKSPACE, TRACKED, ["workspace"]);
    addRows(impl, gadget(GADGET), TRACKED, ["gadget"]);
    addRows(impl, chat(2), TRACKED, ["other-chat"]);
    world.roles.set("bob", "build");
    world.roles.set("carol", "use");
    for (let profileId of ["bob", "carol"]) {
      impl.storage.observers.put(
          { profileId, observerId: `obs-${profileId}`, accountChoices: { [TRACKED]: 20 } });
    }
    world.verifiers.set("carol", observerVerifier(() => world, "carol", ids => ids));

    impl.isLiveExecution = (chatId: number, id: string) => chatId === 1 && id === "e1";
    await impl.authorizeObservation(TRACKED, observation({ subresources: ["read"] }),
        { from: "agent", chatId: 1 }, "e1");

    expect(world.checks).toEqual([{ profileId: "bob", ids: ["read"] }]);
    expect(rows(impl, chat(1))).toEqual(["2:read"]);
    expect(rows(impl, chat(2))).toEqual(["2:other-chat"]);
    expect(rows(impl, gadget(GADGET))).toEqual(["2:gadget"]);
    expect(rows(impl, WORKSPACE)).toEqual(["2:workspace"]);

    impl.isLiveExecution = () => false;
    let before = impl.storage.nextActionId.get();
    await expect(impl.authorizeObservation(TRACKED, observation({ subresources: ["late"] }),
        { from: "agent", chatId: 1 }, "e1"))
        .rejects.toThrow(/has ended/);
    expect(rows(impl, chat(1))).toEqual(["2:read"]);
    expect(impl.storage.nextActionId.get()).toBe(before);
  }));

  it("refuses a read whose execution ends while observer verification is in flight", () =>
      withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    world.roles.set("bob", "build");
    impl.storage.observers.put(
        { profileId: "bob", observerId: "obs-b", accountChoices: { [TRACKED]: 20 } });
    let release!: () => void;
    let reached!: () => void;
    let parked = new Promise<void>(resolve => { release = resolve; });
    let checking = new Promise<void>(resolve => { reached = resolve; });
    world.verifiers.set("bob", observerVerifier(() => world, "bob", async () => {
      reached();
      await parked;
      return [];
    }));
    let live = "e1";
    impl.isLiveExecution = (chatId: number, id: string) => chatId === 1 && id === live;
    let before = impl.storage.nextActionId.get();
    let read = impl.authorizeObservation(TRACKED, observation({ subresources: ["X"] }),
        { from: "agent", chatId: 1 }, "e1");
    await checking;
    live = "e2";
    release();
    await expect(read).rejects.toThrow(/has ended/);
    expect(rows(impl, chat(1))).toEqual([]);
    expect(impl.storage.nextActionId.get()).toBe(before);
    expect(impl.storage.actions.get(before)).toBeUndefined();
  }));

  it("checks newly reachable collaborators when sharing changes during verification", () =>
      withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    world.roles.set("bob", "build");
    world.roles.set("carol", "use");
    for (let profileId of ["bob", "carol"]) {
      impl.storage.observers.put(
          { profileId, observerId: `obs-${profileId}`, accountChoices: { [TRACKED]: 20 } });
    }
    let release!: () => void;
    let reached!: () => void;
    let parked = new Promise<void>(resolve => { release = resolve; });
    let checking = new Promise<void>(resolve => { reached = resolve; });
    world.verifiers.set("bob", observerVerifier(() => world, "bob", async () => {
      reached();
      await parked;
      return [];
    }));
    world.verifiers.set("carol", observerVerifier(() => world, "carol", ids => ids));
    let before = impl.storage.nextActionId.get();
    let read = impl.authorizeObservation(TRACKED, observation({ subresources: ["private"] }),
        { from: "user", chatId: 1 }, true);
    await checking;
    world.roles.set("carol", "build");
    release();

    await expect(read).rejects.toThrow(/could not be confirmed/);
    expect(world.checks.some(check => check.profileId === "carol")).toBe(true);
    expect(rows(impl, chat(1))).toEqual([]);
    expect(impl.storage.nextActionId.get()).toBe(before);
    expect(impl.storage.actions.get(before)).toBeUndefined();
  }));

  it("records gadget reads on the originating gadget and checks both collaborator roles", () =>
      withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    seedGadget(impl);
    seedGadget(impl, GADGET + 1);
    addRows(impl, WORKSPACE, TRACKED, ["workspace"]);
    addRows(impl, chat(1), TRACKED, ["chat"]);
    addRows(impl, gadget(GADGET), TRACKED, ["other-gadget"]);
    addRows(impl, gadget(GADGET + 1), TRACKED, ["retained"]);
    world.roles.set("bob", "build");
    world.roles.set("carol", "use");
    for (let profileId of ["bob", "carol"]) {
      impl.storage.observers.put(
          { profileId, observerId: `obs-${profileId}`, accountChoices: { [TRACKED]: 20 } });
    }

    impl.bindWorkpiece(GADGET + 1, "DB", TRACKED);
    expect(impl.storage.gadgets.get(GADGET + 1).bindings.DB).toEqual({ target: TRACKED });
    impl.storage.defaultGadgetId.put(GADGET);
    let caller = { from: "gadget", chatId: 1, gadgetId: GADGET + 1 };
    await impl.authorizeObservation(TRACKED, observation({ subresources: ["first"] }),
        caller, true);
    await impl.authorizeObservation(TRACKED, observation({ subresources: ["second"] }),
        caller, true);

    expect(world.checks).toHaveLength(4);
    for (let profileId of ["bob", "carol"]) {
      expect(world.checks.filter(check => check.profileId === profileId)).toEqual([
        { profileId, ids: ["first"] },
        { profileId, ids: ["second"] },
      ]);
    }
    expect(rows(impl, gadget(GADGET + 1))).toEqual(["2:first", "2:retained", "2:second"]);
    expect(rows(impl, gadget(GADGET))).toEqual(["2:other-gadget"]);
    expect(rows(impl, chat(1))).toEqual(["2:chat"]);
    expect(rows(impl, WORKSPACE)).toEqual(["2:workspace"]);
  }));

  it.each(["build", "use"] as const)(
      "does not commit a gadget read refused by a %s collaborator", role =>
      withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    seedGadget(impl);
    addRows(impl, gadget(GADGET), TRACKED, ["retained"]);
    world.roles.set("carol", role);
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [TRACKED]: 20 } });
    world.verifiers.set("carol", observerVerifier(() => world, "carol", ids => ids));
    let before = impl.storage.nextActionId.get();

    await expect(impl.authorizeObservation(TRACKED, observation({ subresources: ["denied"] }),
        { from: "gadget", gadgetId: GADGET }))
        .rejects.toThrow(/could not be confirmed/);

    expect(world.checks).toEqual([{ profileId: "carol", ids: ["denied"] }]);
    expect(rows(impl, gadget(GADGET))).toEqual(["2:retained"]);
    expect(rows(impl, WORKSPACE)).toEqual([]);
    expect(impl.storage.nextActionId.get()).toBe(before);
    expect(impl.storage.actions.get(before)).toBeUndefined();
  }));

  it("refuses tracked observations with no attributable context", () =>
      withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    fakeFacets(impl);
    impl.storage.defaultGadgetId.put(GADGET);
    let before = impl.storage.nextActionId.get();

    // A gadget caller persisted before multi-gadget support has no gadgetId. Even a default
    // gadget and chatId do not make that historical caller attributable.
    await expect(impl.authorizeObservation(TRACKED, observation({ subresources: ["x"] }),
        { from: "gadget", chatId: 1 }, true)).rejects.toThrow(/no attributable chat or gadget/);

    expect([...impl.storage.actions.byObserverContext.list()]).toEqual([]);
    expect(impl.storage.nextActionId.get()).toBe(before);
  }));
});
