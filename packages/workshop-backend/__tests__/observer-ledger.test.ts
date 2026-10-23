// Kernel-owned observer tracking (observer-ledger.ts): connections that advertise
// ResourceDescription.supportsObserverTracking coexist with legacy ones, import prior reads once,
// report subresources on every real observation through authorizeTrackedObservation(), and are
// verified by the connection's own verifyObserverAccess(), handed each observer's verifier --
// failing closed on every malformed or failed answer.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// observer-verification-failure.test.ts); gatekeeper facets, User DOs, verifiers, and the sharing
// graph are the fakes.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import type {
  ObservationAuthorizer, ObservationDescription, TrackedObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "../src/overseer.js";
import {
  observerRequirementKey, observerRequirementSubresource, type GatekeeperCaller,
  type GatekeeperRecord, type ObserverContext,
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

// A vendor's verifier for one account: answers which of `ids` it cannot read, through a
// vendor-specific method only its gatekeeper calls.
type VendorVerifier = { deniedSubresources(ids: string[]): Promise<string[]> };
type ObserverToCheck = { id: string, verifier: VendorVerifier };
type VerifyObserverAccess = (observers: ObserverToCheck[], ids: string[]) => unknown;

// One test's fakes: who holds which role, what each profile's verifier answers, and what was
// asked of them.
type World = {
  impl: any;
  instance: OverseerDurableObject;
  roles: Map<string, "build" | "use">;
  // Per profile: the whole verifier, or an Error its User DO's getVerifier() throws.
  verifiers: Map<string, unknown>;
  checks: Check[];
  // Restarts the workspace scheduled. Recorded instead of run: a real one aborts this DO, so a
  // test that needs the restart itself aborts the DO and opens it again.
  restarts: string[];
  clientUser(profileId: string): any;
};

// `answer` gives the denied IDs from `ids`.
function observerVerifier(world: () => World, profileId: string,
                          answer: (ids: string[]) => string[] | Promise<string[]> = () => []):
    VendorVerifier {
  return {
    deniedSubresources: async (ids: string[]) => {
      world().checks.push({ profileId, ids });
      return await answer(ids);
    },
  };
}

// A tracked connection's verifyObserverAccess(): asks every observer's own verifier at once, and
// allows each one whose verifier denies none of `ids`.
async function verifyEachObserver(observers: ObserverToCheck[], ids: string[]) {
  let denied = await Promise.all(
      observers.map(observer => observer.verifier.deniedSubresources(ids)));
  return {
    allowedObserverIds: observers.filter((_, i) => denied[i].length === 0)
        .map(observer => observer.id),
  };
}

// `ids` followed by a hole.
function sparseIds(ids: string[]): string[] {
  let sparse = [...ids];
  sparse.length++;
  return sparse;
}

// Answers a connection's verifyObserverAccess() may give that must refuse every observer in the
// call (null: the connection lacks the method).
const refusingAnswers: [string, VerifyObserverAccess | null][] = [
  ["an omitted observer", () => ({ allowedObserverIds: [] })],
  ["missing allowed IDs", () => ({})],
  ["non-array allowed IDs", observers => ({ allowedObserverIds: observers[0].id })],
  ["sparse allowed IDs",
    observers => ({ allowedObserverIds: sparseIds(observers.map(observer => observer.id)) })],
  ["non-string allowed IDs",
    observers => ({ allowedObserverIds: [...observers.map(observer => observer.id), false] })],
  ["an allowed ID that was not asked about",
    observers => ({ allowedObserverIds: [...observers.map(observer => observer.id), "obs-x"] })],
  ["an unwrapped array", observers => observers.map(observer => observer.id)],
  ["a missing method", null],
  ["a failed check", () => { throw new Error("provider down"); }],
];

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
      restarts: [],
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
    world.impl.scheduleAccessRestart = async (reason: string) => { world.restarts.push(reason); };
    // Tracked connections verify an observation's audience through their facet.
    world.impl.getGatekeeperFacet = async () => ({ verifyObserverAccess: verifyEachObserver });
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
    type: "observation", description: trackedObservation(ids),
  });
}

// Every subresource the requirement index holds on `context`, whether or not its connection
// still exists.
function rows(impl: ObserverImpl, context: ObserverContext): string[] {
  let connections = new Set(Array.from(impl.storage.actions.list(), record => record.gatekeeperId));
  let found: string[] = [];
  for (let gatekeeperId of connections) {
    let prefix = observerRequirementKey(gatekeeperId, context, "");
    for (let key of impl.storage.actions.byObserverRequirement.listKeys({ prefix })) {
      found.push(`${gatekeeperId}:${observerRequirementSubresource(key)}`);
    }
  }
  return found.toSorted();
}

// What admission requires of `role` through every connection in the workspace.
function requirements(impl: ObserverImpl, role: "build" | "use"): Map<number, string[]> {
  return impl.observerLedger.requiredSubresources(role, Array.from(impl.storage.gatekeepers.list()));
}

// Switches a legacy connection that now advertises support to tracking, then waits for the
// history import the switch started in the background.
async function switchAndImport(impl: ObserverImpl, id = LEGACY): Promise<void> {
  expect(await impl.observerLedger.switchToTracking(id)).toBe(true);
  await impl.observerLedger.importHistory(id);
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
        await switchAndImport(impl);
      } else {
        seedTracked(impl);
        await impl.authorizeTrackedObservation(TRACKED, trackedObservation(ids),
            { from: "gadget", gadgetId: GADGET });
      }
      let connection = historical ? LEGACY : TRACKED;
      expect(requirements(impl, "use").get(connection)?.toSorted())
          .toEqual(ids.toSorted());
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
      let run = () => historical ? switchAndImport(impl)
          : impl.authorizeTrackedObservation(TRACKED, trackedObservation(ids, {
            containsRestrictedData: true, ownerInvitesOnly: true,
          }), { from: "user" });
      try {
        await expect(run()).rejects.toThrow("later chunk failed");
      } finally {
        impl.storage.actions.put = put;
      }
      expect(impl.storage.nextActionId.get()).toBe(before);
      expect([...impl.storage.actions.list()]).toEqual([]);
      expect(requirements(impl, "build").size).toBe(0);
      expect(impl.storage.containsRestrictedData.get()).toBeFalsy();
      expect(impl.storage.ownerInvitesOnly.get()).toBeFalsy();
      // A failed import commits nothing, leaving the connection tracked with its history pending.
      if (historical) {
        expect(impl.storage.gatekeepers.get(LEGACY))
            .toMatchObject({ observerTracking: true, observerHistoryPending: true });
      }
      await run();
      expect(requirements(impl, "build").get(historical ? LEGACY : TRACKED)
          ?.toSorted()).toEqual(ids.toSorted());
      if (historical) {
        expect(impl.storage.gatekeepers.get(LEGACY).observerHistoryPending).toBeUndefined();
      } else {
        expect(impl.storage.containsRestrictedData.get()).toBe(true);
        expect(impl.storage.ownerInvitesOnly.get()).toBe(true);
      }
    }));
  }
});

// Facets: legacy ones advertise nothing; tracked ones advertise support and refuse addObserver(),
// as the contract requires. An export resolves no sooner than a real RPC, after a macrotask, so
// switchAndImport() joins the import the switch started. `verify` replaces verifyObserverAccess()
// (null removes it).
function fakeFacets(impl: any, opts: {
  adds?: number[],
  exports?: Map<number, () => Promise<string[]>>,
  advertise?: Set<number>,
  verify?: VerifyObserverAccess | null,
} = {}): void {
  let tracked = (id: number) =>
      opts.advertise?.has(id) || impl.storage.gatekeepers.get(id)?.observerTracking;
  impl.getGatekeeperFacet = async (id: number) => ({
    describe: async () => ({
      url: `https://example.com/${id}`, title: `Connection ${id}`, snippet: "",
      suggestedBindingName: "C", tsType: "C",
      ...(tracked(id) ? { supportsObserverTracking: true } : {}),
    }),
    getHistoricalSubresources: async () => {
      await scheduler.wait(0);
      return await opts.exports?.get(id)?.() ?? [];
    },
    ...(opts.verify === null ? {} : { verifyObserverAccess: opts.verify ?? verifyEachObserver }),
    addObserver: async () => {
      if (tracked(id)) throw new Error("This connection is tracked by the Workshop.");
      opts.adds?.push(id);
    },
    removeObserver: async () => {},
  });
}

const configureAll = {
  configure: async (needs: { gatekeeperId: number }[]) =>
      needs.map(need => ({ gatekeeperId: need.gatekeeperId, accountId: need.gatekeeperId * 10 })),
} as any;

function observation(extra: Partial<ObservationDescription> = {}): ObservationDescription {
  return { title: "Read", description: "A read", ...extra };
}

function trackedObservation(subresources: string[],
                            extra: Partial<TrackedObservationDescription> = {}):
    TrackedObservationDescription {
  return { title: "Read", description: "A read", ...extra, subresources };
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
  it.each([
    { hookGadget: undefined, defaultGadget: undefined, context: WORKSPACE },
    { hookGadget: GADGET, defaultGadget: undefined, context: gadget(GADGET) },
    { hookGadget: undefined, defaultGadget: GADGET, context: gadget(GADGET) },
  ])("delivers through the firing queue and records requirements on the gadget it wakes " +
      "(hook gadgetId: $hookGadget, default gadget: $defaultGadget)",
      ({ hookGadget, defaultGadget, context }) => withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    seedGadget(impl);
    impl.defaultGadgetId = defaultGadget;
    addRows(impl, gadget(GADGET), TRACKED, ["gadget-only"]);
    for (let [profileId, role] of [["bob", "build"], ["carol", "use"]] as const) {
      world.roles.set(profileId, role);
      impl.storage.observers.put(
          { profileId, observerId: `obs-${profileId}`, accountChoices: { [TRACKED]: 20 } });
    }
    using firing = await startTrackedHook(world, hookGadget);
    let before = impl.storage.nextActionId.get();

    await firing.approvalQueue.authorizeTrackedObservation(trackedObservation(["hook/event"]));
    await firing.deliver("evt");

    expect(firing.deliveries).toEqual(["evt"]);
    expect(world.checks).toHaveLength(2);
    for (let profileId of ["bob", "carol"]) {
      expect(world.checks).toContainEqual({ profileId, ids: ["hook/event"] });
    }
    let onGadget = context.type === "gadget";
    expect(rows(impl, WORKSPACE)).toEqual(onGadget ? [] : ["2:hook/event"]);
    expect(rows(impl, gadget(GADGET)))
        .toEqual(onGadget ? ["2:gadget-only", "2:hook/event"] : ["2:gadget-only"]);
    expect(impl.storage.actions.get(before)).toMatchObject({
      gatekeeperId: TRACKED, type: "observation", state: "approved",
      description: { subresources: ["hook/event"] },
    });
    expect(impl.storage.actions.get(before).caller)
        .toEqual(onGadget ? { from: "hook", gadgetId: GADGET } : { from: "hook" });
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
      await firing.approvalQueue.authorizeTrackedObservation(trackedObservation(["denied"]));
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
        await firing.approvalQueue.authorizeTrackedObservation(trackedObservation(["past/event"]));
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
        expect(requirements(impl, role).get(TRACKED)).toEqual(["past/event"]);
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
      // For "restart", the hook wakes a gadget still provisional to a chat, so the connection is
      // outside "use" scope until a gadget binds it below.
      let pendingGadget = GADGET + 1;
      if (operation === "restart") {
        impl.storage.gadgets.put({
          type: "gadget", id: pendingGadget, title: "P", created: new Date(0),
          bindingName: "P", bindings: {}, pending: { chatId: 1 },
        });
        seedGadget(impl);
      }
      using firing = await startTrackedHook(world,
          operation === "restart" ? pendingGadget : undefined);
      let before = impl.storage.nextActionId.get();
      let authorize = firing.approvalQueue.authorizeTrackedObservation(trackedObservation(
          ["racing/event"], { containsRestrictedData: true, ownerInvitesOnly: true }))
          .then(() => ({ authorized: true, error: "" }),
          error => ({ authorized: false, error: String(error) }));
      await checking;
      let refusal = operation === "restart" ? /restarting/ : /deleted or disabled/;
      if (operation === "restart") {
        // Binding it while a "use" session is live widens that session's scope, so the workspace
        // restarts and holds the connection back until the reset lands.
        using _session = { [Symbol.dispose]: impl.joinSession("use") };
        impl.bindWorkpiece(GADGET, "C", TRACKED);
        expect(world.restarts).toHaveLength(1);
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
    let mixed = { ...trackedObservation([]), excludeObservers: [record.observerId] };
    await expect(impl.authorizeTrackedObservation(TRACKED, mixed, { from: "user" }))
        .rejects.toThrow(/cannot exclude observers/);
  }));

  it("switches a legacy connection at its first tracked observation, and authorizes that read", () =>
      withWorld(async world => {
    let { impl } = world;
    seedLegacy(impl);
    seedGadget(impl);
    let exports = 0;
    fakeFacets(impl, {
      advertise: new Set([LEGACY]),
      exports: new Map([[LEGACY, async () => { exports++; return ["history"]; }]]),
    });
    world.roles.set("carol", "build");
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [LEGACY]: 10 } });
    // A session minted before the Workshop noticed the upgrade makes a tracked observation: the
    // connection switches, and the read is checked and recorded like any other.
    await impl.authorizeTrackedObservation(LEGACY, trackedObservation(["x"]),
        { from: "gadget", gadgetId: GADGET });
    expect(impl.observerLedger.isTracked(LEGACY)).toBe(true);
    expect(world.checks).toEqual([{ profileId: "carol", ids: ["x"] }]);
    expect(rows(impl, gadget(GADGET))).toEqual(["1:x"]);

    // The switch imports the connection's history into the workspace, exactly once.
    await impl.observerLedger.importHistory(LEGACY);
    await impl.observerLedger.importHistory(LEGACY);
    expect(rows(impl, WORKSPACE)).toEqual(["1:history"]);
    expect(impl.storage.gatekeepers.get(LEGACY).observerHistoryPending).toBeUndefined();
    expect(exports).toBe(1);
    expect(world.restarts).toEqual([]);
    expect(impl.gatekeeperUsable(LEGACY)).toBe(true);
  }));

  it("refuses subresources sent through the legacy method, recording and importing nothing", () =>
      withWorld(async world => {
    let { impl } = world;
    seedLegacy(impl);
    fakeFacets(impl, { advertise: new Set([LEGACY]) });
    let before = impl.storage.nextActionId.get();
    // Only authorizeTrackedObservation() checks them: accepting them here would let the read
    // through without checking anyone, as a Workshop that predates tracking would.
    let misrouted = { ...observation(), subresources: ["x"] };
    await expect(impl.authorizeObservation(LEGACY, misrouted, { from: "user" }))
        .rejects.toThrow(/authorizeTrackedObservation/);
    expect(impl.storage.nextActionId.get()).toBe(before);
    expect(impl.observerLedger.isTracked(LEGACY)).toBe(false);
  }));

  it("refuses a tracked observation through a connection that doesn't advertise tracking", () =>
      withWorld(async world => {
    let { impl } = world;
    seedLegacy(impl);
    fakeFacets(impl);
    let before = impl.storage.nextActionId.get();
    await expect(impl.authorizeTrackedObservation(LEGACY, trackedObservation(["x"]),
        { from: "user" })).rejects.toThrow(/does not advertise observer tracking/);
    expect(impl.storage.nextActionId.get()).toBe(before);
    expect(impl.observerLedger.isTracked(LEGACY)).toBe(false);
  }));
});

describe("observations through a tracked connection", () => {
  it("accept an explicit [] and refuse omitted IDs", () => withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    let before = impl.storage.nextActionId.get();

    await impl.authorizeTrackedObservation(TRACKED, trackedObservation([]), { from: "user" });
    expect(impl.storage.nextActionId.get()).toBe(before + 1);  // audited
    expect(rows(impl, WORKSPACE)).toEqual([]);

    await expect(impl.authorizeObservation(TRACKED, observation(), { from: "user" }))
        .rejects.toThrow(/must report its subresources/);
    expect(impl.storage.nextActionId.get()).toBe(before + 1);
  }));

  it("refuse IDs that are not well-formed Unicode", () => withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    let before = impl.storage.nextActionId.get();

    // Storage would turn both lone surrogates into the same replacement characters.
    await expect(impl.authorizeTrackedObservation(TRACKED,
        trackedObservation(["doc:\uD800", "doc:\uDBFF"]), { from: "user" }))
        .rejects.toThrow(/well-formed/);
    expect(impl.storage.nextActionId.get()).toBe(before);
  }));

  it.each(refusingAnswers)("fail closed on %s from the connection's access check",
      (_name, verify) => withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    let registrations: number[] = [];
    fakeFacets(impl, { adds: registrations, verify });
    world.roles.set("carol", "use");
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [TRACKED]: 20 } });
    let before = impl.storage.nextActionId.get();

    await expect(impl.authorizeTrackedObservation(TRACKED, trackedObservation(["x", "y"]),
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

    await impl.authorizeTrackedObservation(TRACKED, trackedObservation(["x"]), { from: "user" });
    expect(world.checks).toEqual([{ profileId: "carol", ids: ["x"] }]);
    expect(rows(impl, WORKSPACE)).toEqual(["2:x"]);

    // A remembered ID is not a remembered grant: the next read checks it again.
    await impl.authorizeTrackedObservation(TRACKED, trackedObservation(["x"]), { from: "user" });
    expect(world.checks).toHaveLength(2);
  }));

  it("refuse a read denied only by an observer past the first access-check call", () =>
      withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    let calls: string[][] = [];
    fakeFacets(impl, {
      verify: (observers, ids) => {
        calls.push(observers.map(observer => observer.id));
        return verifyEachObserver(observers, ids);
      },
    });
    let profiles = Array.from({ length: 11 }, (_, i) => `p${String(i).padStart(2, "0")}`);
    for (let profileId of profiles) {
      world.roles.set(profileId, "build");
      impl.storage.observers.put(
          { profileId, observerId: `obs-${profileId}`, accountChoices: { [TRACKED]: 20 } });
    }
    world.verifiers.set("p10", observerVerifier(() => world, "p10", ids => ids));
    let before = impl.storage.nextActionId.get();

    await expect(impl.authorizeTrackedObservation(TRACKED, trackedObservation(["x"]),
        { from: "user" })).rejects.toThrow(/could not be confirmed/);

    // Each call carries at most ten observers; the denier is alone in the second.
    expect(calls.map(call => call.length)).toEqual([10, 1]);
    expect(calls[1]).toEqual(["obs-p10"]);
    expect(world.checks.map(check => check.profileId).toSorted()).toEqual(profiles);
    expect(rows(impl, WORKSPACE)).toEqual([]);
    expect(impl.storage.nextActionId.get()).toBe(before);
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
        read ??= impl.authorizeTrackedObservation(TRACKED, trackedObservation(["x"]),
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
    let read = impl.authorizeTrackedObservation(TRACKED, trackedObservation(["x"]),
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

  // Admission shares the observation path's answer validation (see refusingAnswers), so only its
  // own outcomes are repeated here: a denial, and a verifier lookup that fails.
  it.each([
    ["a denial", {
      verify: (() => ({ allowedObserverIds: [] })) satisfies VerifyObserverAccess,
      lookupFailure: undefined, reason: /can't access some of the data/,
    }] as const,
    ["a wrong vendor or failed lookup", {
      verify: undefined, reason: /Invalid account selection/,
      lookupFailure: new Error("Invalid account selection for this service."),
    }] as const,
  ])("fails closed on %s, with no legacy fallback", (_name, { verify, lookupFailure, reason }) =>
      withWorld(async world => {
    let { impl } = world;
    seedTracked(impl);
    addRows(impl, WORKSPACE, TRACKED, ["a"]);
    let adds: number[] = [];
    fakeFacets(impl, { adds, verify });
    world.roles.set("carol", "build");
    if (lookupFailure) world.verifiers.set("carol", lookupFailure);
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [TRACKED]: 20 } });

    let admission = impl.ensureObserver("carol", world.clientUser("carol"), "build");
    await expect(admission).rejects.toThrow(/could not confirm/);
    await expect(admission).rejects.toThrow(reason);
    expect(adds).toEqual([]);  // never handed to the facet's addObserver
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
    await impl.authorizeTrackedObservation(TRACKED, trackedObservation(["b"]), { from: "user" });
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

    let read = impl.authorizeTrackedObservation(TRACKED, trackedObservation(["x"]),
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

  it("ignores reads outside a use collaborator's scope that land while she is verified", () =>
      withWorld(async world => {
    let { impl } = world;
    let unbound = TRACKED + 1;
    seedTracked(impl);
    seedTracked(impl, unbound);
    seedGadget(impl, GADGET, { C: TRACKED });
    addRows(impl, WORKSPACE, TRACKED, ["bound"]);
    fakeFacets(impl);
    world.roles.set("carol", "use");
    let reads = 0;
    world.verifiers.set("carol", observerVerifier(() => world, "carol", async () => {
      // The owner keeps reading through a connection nothing binds while Carol is checked.
      await impl.authorizeTrackedObservation(unbound,
          trackedObservation([`unbound-${++reads}`]), { from: "user" });
      return [];
    }));

    await impl.ensureObserver("carol", world.clientUser("carol"), "use", configureAll);

    expect(world.checks).toEqual([{ profileId: "carol", ids: ["bound"] }]);
    expect(impl.storage.observers.get("carol").accountChoices).toEqual({ [TRACKED]: 20 });
  }));

  it("verifies existing reads through a connection that enters a use scope mid-verification", () =>
      withWorld(async world => {
    let { impl } = world;
    let later = TRACKED + 1;
    seedTracked(impl);
    seedTracked(impl, later);
    seedGadget(impl, GADGET, { C: TRACKED });
    addRows(impl, WORKSPACE, TRACKED, ["bound"]);
    addRows(impl, WORKSPACE, later, ["secret"]);
    fakeFacets(impl);
    world.roles.set("carol", "use");
    world.verifiers.set("carol", observerVerifier(() => world, "carol", ids => {
      // Binding records no action, so only the scope's connections show that it changed.
      seedGadget(impl, GADGET, { C: TRACKED, D: later });
      return ids.filter(id => id === "secret");
    }));

    await expect(impl.ensureObserver("carol", world.clientUser("carol"), "use", configureAll))
        .rejects.toThrow(/could not confirm/);
    expect(world.checks).toContainEqual({ profileId: "carol", ids: ["secret"] });
    expect(impl.storage.observers.get("carol")).toBeUndefined();
  }));
});

describe("historical import", () => {
  it.each(["allowed", "denied", "unavailable"] as const)(
      "rechecks an upgrade after account selection (%s)", outcome => withWorld(async world => {
    let { impl } = world;
    seedLegacy(impl);
    let advertise = new Set<number>();
    let adds: number[] = [];
    let exports = 0;
    fakeFacets(impl, {
      advertise, adds,
      exports: new Map([[LEGACY, async () => { exports++; return ["restricted/history"]; }]]),
    });
    let getFacet = impl.getGatekeeperFacet;
    impl.getGatekeeperFacet = async (id: number) => {
      let facet = await getFacet(id);
      return {
        ...facet,
        describe: async () => {
          if (advertise.has(id) && outcome === "unavailable") throw new Error("Discovery unavailable");
          return facet.describe();
        },
      };
    };
    world.verifiers.set("carol", observerVerifier(() => world, "carol",
        ids => outcome === "allowed" ? [] : ids));
    let release!: () => void;
    let reached!: () => void;
    let parked = new Promise<void>(resolve => { release = resolve; });
    let prompted = new Promise<void>(resolve => { reached = resolve; });
    let configureCb = {
      configure: async (needs: { gatekeeperId: number }[]) => {
        reached();
        await parked;
        return configureAll.configure(needs);
      },
    };
    let admission = impl.ensureObserver("carol", world.clientUser("carol"), "build", configureCb)
        .then(() => ({ allowed: true, error: "" }),
            (error: unknown) => ({ allowed: false, error: String(error) }));
    await prompted;
    advertise.add(LEGACY);
    release();

    let result = await admission;
    expect(result.allowed).toBe(outcome === "allowed");
    expect(adds).toEqual([]);
    if (outcome === "allowed") {
      expect(impl.storage.observers.get("carol").accountChoices).toEqual({ [LEGACY]: 10 });
    } else {
      expect(result.error).toMatch(/could not confirm/);
      expect(impl.storage.observers.get("carol")).toBeUndefined();
    }
    if (outcome === "unavailable") {
      expect(exports).toBe(0);
      expect(rows(impl, WORKSPACE)).toEqual([]);
    } else {
      expect(exports).toBe(1);
      expect(rows(impl, WORKSPACE)).toEqual(["1:restricted/history"]);
      expect(world.checks).toContainEqual({ profileId: "carol", ids: ["restricted/history"] });
    }
  }));

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
    expect(await impl.observerLedger.switchToTracking(LEGACY)).toBe(false);
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

  it("keeps an addObserver refusal when describing the connection fails, and switches once it " +
      "succeeds", () => withWorld(async world => {
    let { impl } = world;
    seedLegacy(impl);
    fakeFacets(impl);
    let fail = true;
    let describes = 0;
    let exports = 0;
    let getFacet = impl.getGatekeeperFacet;
    // An upgraded gatekeeper that refuses addObserver(), but can't always be described.
    impl.getGatekeeperFacet = async (id: number) => ({
      ...await getFacet(id),
      describe: async () => {
        describes++;
        if (fail) throw new Error("Discovery unavailable");
        return { supportsObserverTracking: true };
      },
      getHistoricalSubresources: async () => {
        exports++;
        return ["restricted/history"];
      },
      addObserver: async () => { throw new Error("This connection is tracked by the Workshop."); },
    });

    let prompts: (string | undefined)[][] = [];
    let configure = {
      configure: async (needs: { gatekeeperId: number, failure?: { reason: string } }[]) => {
        prompts.push(needs.map(need => need.failure?.reason));
        return configureAll.configure(needs);
      },
    };
    await expect(impl.ensureObserver("carol", world.clientUser("carol"), "build", configure))
        .rejects.toThrow(/Legacy 1 .*tracked by the Workshop/);
    // The addObserver refusal is that binding's own, offered for repair before admission is
    // denied; each refusal describes the connection once.
    expect(prompts).toEqual([[undefined], [expect.stringMatching(/tracked by the Workshop/)]]);
    expect(describes).toBe(2);
    expect(exports).toBe(0);
    expect(impl.storage.observers.get("carol")).toBeUndefined();
    expect(impl.storage.gatekeepers.get(LEGACY).observerTracking).toBeUndefined();
    expect(impl.storage.gatekeepers.get(LEGACY).observerHistoryPending).toBeUndefined();

    fail = false;
    world.verifiers.set("carol", observerVerifier(() => world, "carol", ids => ids));
    await expect(impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll))
        .rejects.toThrow(/could not confirm/);
    expect(impl.observerLedger.isTracked(LEGACY)).toBe(true);
    expect(impl.storage.observers.get("carol")).toBeUndefined();
    expect(world.checks).toContainEqual({ profileId: "carol", ids: ["restricted/history"] });
    expect(rows(impl, WORKSPACE)).toEqual(["1:restricted/history"]);
    expect(exports).toBe(1);
  }));

  it("keeps an addObserver refusal from a connection that doesn't advertise tracking", () =>
      withWorld(async world => {
    let { impl } = world;
    seedLegacy(impl);
    fakeFacets(impl);
    let describes = 0;
    let getFacet = impl.getGatekeeperFacet;
    impl.getGatekeeperFacet = async (id: number) => {
      let facet = await getFacet(id);
      return {
        ...facet,
        describe: async () => { describes++; return facet.describe(); },
        addObserver: async () => { throw new Error("This account can't read the sheet."); },
      };
    };
    world.roles.set("carol", "build");
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [LEGACY]: 10 } });

    await expect(impl.ensureObserver("carol", world.clientUser("carol"), "build"))
        .rejects.toThrow(/Legacy 1 .*can't read the sheet/);
    expect(describes).toBe(1);
    expect(impl.observerLedger.isTracked(LEGACY)).toBe(false);
  }));

  it("admits a legacy collaborator through addObserver without describing the connection", () =>
      withWorld(async world => {
    let { impl } = world;
    seedLegacy(impl);
    let adds: number[] = [];
    fakeFacets(impl, { adds });
    let describes = 0;
    let getFacet = impl.getGatekeeperFacet;
    // Describing may use credentials the collaborator lacks: a describe() that throws must not
    // lock out a collaborator the legacy protocol admits.
    impl.getGatekeeperFacet = async (id: number) => ({
      ...await getFacet(id),
      describe: async () => { describes++; throw new Error("Owner credentials expired"); },
      startSession: async () => ({}),
    });

    await impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll);
    expect(adds).toEqual([LEGACY]);
    expect(impl.storage.observers.get("carol").accountChoices).toEqual({ [LEGACY]: 10 });
    await impl.openGatekeeperSession(
        LEGACY, await impl.getGatekeeperFacet(LEGACY), { from: "user" });
    expect(describes).toBe(0);
    expect(impl.observerLedger.isTracked(LEGACY)).toBe(false);
  }));

  it("imports an existing legacy connection that starts advertising, even with no prior reads",
      () => withWorld(async world => {
    let { impl } = world;
    seedLegacy(impl);
    let exports = 0;
    fakeFacets(impl, {
      advertise: new Set([LEGACY]),
      exports: new Map([[LEGACY, async () => { exports++; return []; }]]),
    });
    let before = impl.storage.nextActionId.get();

    await switchAndImport(impl);
    expect(impl.observerLedger.isTracked(LEGACY)).toBe(true);
    expect(impl.storage.gatekeepers.get(LEGACY).observerHistoryPending).toBeUndefined();
    expect(exports).toBe(1);
    // An empty export writes no audit record.
    expect(impl.storage.nextActionId.get()).toBe(before);
    expect(rows(impl, WORKSPACE)).toEqual([]);
    // The switch neither restarts the workspace nor holds the connection back.
    expect(world.restarts).toEqual([]);
    expect(impl.gatekeeperUsable(LEGACY)).toBe(true);

    world.roles.set("carol", "build");
    await impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll);
    await impl.authorizeTrackedObservation(LEGACY, trackedObservation(["first-real-read"]),
        { from: "user" });
    expect(world.checks).toEqual([
      { profileId: "carol", ids: ["first-real-read"] },
    ]);
    expect(rows(impl, WORKSPACE)).toEqual(["1:first-real-read"]);
    expect(exports).toBe(1);
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
    let switches = await Promise.all([
      impl.observerLedger.switchToTracking(3), impl.observerLedger.switchToTracking(3),
    ]);
    expect(switches).toEqual([true, true]);
    await Promise.all([impl.observerLedger.importHistory(3), impl.observerLedger.importHistory(3)]);
    expect(exports).toBe(1);
    expect(impl.observerLedger.isTracked(3)).toBe(true);
    // One workspace audit record carries the whole (deduplicated) export.
    expect(impl.storage.nextActionId.get()).toBe(before + 1);
    expect(impl.storage.actions.get(before)).toMatchObject({
      gatekeeperId: 3, type: "observation", caller: { from: "user" },
      description: { subresources: ["p1", "p2"] },
    });
    // Every context, existing or future, includes workspace requirements.
    expect(requirements(impl, "use").get(3)).toEqual(["p1", "p2"]);
  }));

  it("imports a history larger than one observation and checks every verification batch",
      () => withWorld(async world => {
    let { impl } = world;
    let ids = Array.from({ length: 10_001 }, (_, i) => String(i));
    seedLegacy(impl);
    fakeFacets(impl, {
      advertise: new Set([LEGACY]),
      exports: new Map([[LEGACY, async () => ids]]),
    });
    await switchAndImport(impl);
    let required = requirements(impl, "build").get(LEGACY)!;
    expect(required.toSorted()).toEqual(ids.toSorted());
    world.roles.set("carol", "build");
    world.verifiers.set("carol", observerVerifier(() => world, "carol",
        batch => batch.filter(id => id === required.at(-1))));
    await expect(impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll))
        .rejects.toThrow(/could not confirm/);
    expect(world.checks).toContainEqual({ profileId: "carol", ids: required.slice(10_000) });
    expect(impl.storage.observers.get("carol")).toBeUndefined();

    // One observation is still held to its own limit.
    await expect(impl.authorizeTrackedObservation(LEGACY, trackedObservation(ids),
        { from: "user" })).rejects.toThrow(/at most 10000/);
    expect(requirements(impl, "build").get(LEGACY)).toEqual(required);
    world.verifiers.delete("carol");
    await impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll);
    expect(impl.storage.observers.get("carol").accountChoices).toEqual({ [LEGACY]: 10 });
  }));

  it("refuses an export with an invalid ID and leaves the history pending", () =>
      withWorld(async world => {
    let { impl } = world;
    seedLegacy(impl);
    fakeFacets(impl, {
      advertise: new Set([LEGACY]),
      exports: new Map([[LEGACY, async () => ["doc:ok", "doc:\uD800"]]]),
    });

    await expect(switchAndImport(impl)).rejects.toThrow(/well-formed/);
    expect(impl.storage.gatekeepers.get(LEGACY))
        .toMatchObject({ observerTracking: true, observerHistoryPending: true });
    expect(rows(impl, WORKSPACE)).toEqual([]);
    expect(impl.gatekeeperUsable(LEGACY)).toBe(true);
  }));

  // The pending history is durable: a failure, or the object resetting, leaves it for the next
  // admission to export again.
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
    await inOverseer(name, async ({ impl, restarts }) => {
      seedLegacy(impl, 3);
      facets(impl);
      await expect(switchAndImport(impl, 3)).rejects.toThrow(/export interrupted/);
      // A failed export commits nothing, and leaves the connection tracked and usable with its
      // history still pending.
      expect(impl.storage.gatekeepers.get(3))
          .toMatchObject({ observerTracking: true, observerHistoryPending: true });
      expect(rows(impl, WORKSPACE)).toEqual([]);
      expect(restarts).toEqual([]);
      expect(impl.gatekeeperUsable(3)).toBe(true);
      expect(exports).toBe(1);
    });

    await abortAllDurableObjects();

    fail = false;
    await inOverseer(name, async world => {
      let { impl } = world;
      facets(impl);
      expect(impl.storage.gatekeepers.get(3).observerHistoryPending).toBe(true);
      world.roles.set("carol", "build");
      world.verifiers.set("carol", observerVerifier(() => world, "carol", ids => ids));
      // The next admission exports again, and verifies her against what it imported.
      await expect(impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll))
          .rejects.toThrow(/could not confirm/);
      expect(exports).toBe(2);
      expect(world.checks).toContainEqual({ profileId: "carol", ids: ["p1"] });
      expect(rows(impl, WORKSPACE)).toEqual(["3:p1"]);
      expect(impl.storage.gatekeepers.get(3).observerHistoryPending).toBeUndefined();

      world.verifiers.delete("carol");
      await impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll);
      await impl.observerLedger.importHistory(3);
      expect(exports).toBe(2);  // completion is durable: the stored history is authoritative
    });
  });

  it.each([["the imported", "history"], ["the concurrent", "live"], ["no", null]] as const)(
      "keeps a switched connection usable while its import is parked, and admits only after it " +
      "(denying %s requirement)", (_label, denied) => withWorld(async world => {
    let { impl } = world;
    seedLegacy(impl);
    seedGadget(impl);
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
    world.roles.set("carol", "build");
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [LEGACY]: 10 } });
    expect(await impl.observerLedger.switchToTracking(LEGACY)).toBe(true);
    await exporting;

    // The legacy protocol is refused at once; tracked reads proceed without waiting.
    let before = impl.storage.nextActionId.get();
    await expect(impl.authorizeObservation(LEGACY, observation(), { from: "hook" }))
        .rejects.toThrow(/must report its subresources through authorizeTrackedObservation/);
    expect(impl.storage.nextActionId.get()).toBe(before);
    await impl.authorizeTrackedObservation(LEGACY, trackedObservation(["live"]),
        { from: "gadget", gadgetId: GADGET });
    expect(world.checks).toEqual([{ profileId: "carol", ids: ["live"] }]);
    expect(rows(impl, gadget(GADGET))).toEqual(["1:live"]);
    expect(rows(impl, WORKSPACE)).toEqual([]);
    expect(impl.gatekeeperUsable(LEGACY)).toBe(true);

    // An admission waits for the history before verifying anyone against the connection.
    world.roles.set("dave", "build");
    world.verifiers.set("dave", observerVerifier(() => world, "dave",
        ids => ids.filter(id => id === denied)));
    let { promise: prompted, resolve: promptedResolve } = Promise.withResolvers<void>();
    let configure = {
      configure: async (needs: { gatekeeperId: number }[]) => {
        promptedResolve();
        return configureAll.configure(needs);
      },
    };
    let settled = false;
    let admission = impl.ensureObserver("dave", world.clientUser("dave"), "build", configure)
        .then(() => ({ allowed: true, error: "" }),
            (error: unknown) => ({ allowed: false, error: String(error) }))
        .finally(() => { settled = true; });
    await prompted;
    // Another full read round trip through the connection, while the admission's pass is past
    // its prompt: the read still doesn't wait, and the admission still hasn't checked anyone.
    await impl.authorizeTrackedObservation(LEGACY, trackedObservation(["live"]),
        { from: "gadget", gadgetId: GADGET });
    expect(settled).toBe(false);
    expect(world.checks.filter(check => check.profileId === "dave")).toEqual([]);

    release();
    let result = await admission;
    expect(rows(impl, WORKSPACE)).toEqual(["1:history"]);
    expect(world.checks.map(check => ({ ...check, ids: check.ids.toSorted() })))
        .toContainEqual({ profileId: "dave", ids: ["history", "live"] });
    expect(result.allowed).toBe(denied === null);
    if (denied === null) {
      expect(impl.storage.observers.get("dave").accountChoices).toEqual({ [LEGACY]: 10 });
    } else {
      expect(result.error).toMatch(/could not confirm/);
      expect(impl.storage.observers.get("dave")).toBeUndefined();
    }
    expect(world.restarts).toEqual([]);
  }));

  it("refuses a legacy observation whose connection switches while its policy lookup is in " +
      "flight", () => withWorld(async world => {
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
    expect(await impl.observerLedger.switchToTracking(LEGACY)).toBe(true);
    release();

    // The ledger checks the protocol at commit, so the read commits under neither protocol.
    await expect(read).rejects.toThrow(
        /must report its subresources through authorizeTrackedObservation/);
    expect(impl.storage.nextActionId.get()).toBe(before);
    expect(impl.storage.actions.get(before)).toBeUndefined();
    expect(impl.storage.ownerInvitesOnly.get()).toBe(false);
    expect(impl.storage.containsRestrictedData.get()).toBe(false);
  }));

  it("refuses a legacy exclusion check that the switch overtakes", () =>
      withWorld(async world => {
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
    expect(await impl.observerLedger.switchToTracking(LEGACY)).toBe(true);
    release();

    await expect(read).rejects.toThrow(
        /must report its subresources through authorizeTrackedObservation/);
    expect(impl.storage.nextActionId.get()).toBe(before);
  }));

  it("is skipped for a connection created already advertising support", () =>
      withWorld(async world => {
    let { impl } = world;
    let exports = 0;
    let describe = async () => ({
      url: "https://example.com/new", title: "New", snippet: "", suggestedBindingName: "N",
      tsType: "N", supportsObserverTracking: true,
    });
    impl.getGatekeeperFacet = async () => ({
      describe, getHistoricalSubresources: async () => { exports++; return ["old"]; },
      verifyObserverAccess: verifyEachObserver,
    });

    await impl.addGatekeeper({} as any, spec("trackedvendor", 9), "owner");
    let id = [...impl.storage.gatekeepers.list()][0].id;
    expect(await impl.observerLedger.switchToTracking(id)).toBe(true);
    await impl.observerLedger.importHistory(id);
    expect(impl.storage.gatekeepers.get(id).observerHistoryPending).toBeUndefined();
    expect(impl.observerLedger.isTracked(id)).toBe(true);
    expect(impl.storage.gatekeepers.get(id).observerTracking).toBe(true);
    expect(exports).toBe(0);
    expect(rows(impl, WORKSPACE)).toEqual([]);
  }));

  it("audits simulated reads without external permissions, then checks the approved real resource",
      async () => {
    let name = `observer-ledger-creation-${++doCounter}`;
    let real = false;
    let exports = 0;
    let gatekeeperId!: number;
    let facet = () => ({
      describe: async () => ({
        url: `https://example.com/${real ? "real" : "simulated"}`,
        title: real ? "Real" : "Simulated", snippet: "", suggestedBindingName: "N", tsType: "N",
        supportsObserverTracking: true,
      }),
      getHistoricalSubresources: async () => { exports++; return []; },
      verifyObserverAccess: verifyEachObserver,
      applyCreation: async () => {
        real = true;
        return { class: {}, resourceUrl: "https://example.com/real" };
      },
      startSession: async (queue: ObservationAuthorizer) => ({
        read: (description: TrackedObservationDescription) =>
            queue.authorizeTrackedObservation(description),
      }),
    });

    await inOverseer(name, async world => {
      let { impl } = world;
      impl.ownerId = "owner";
      impl.traceAgentActionApproval = () => {};
      impl.wrapUserDo = (user: unknown) => user;
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
      impl.getGatekeeperFacet = async () => facet();

      let leave = impl.joinSession("build");
      try {
        ({ gatekeeperId } = await impl.createExternalResource(1, {
          vendorId: "trackedvendor", resourceUrlPattern: "https://example.com/*", title: "New",
          bindingName: "N",
        }));
        // A pending creation is simulated, so there is nothing to switch to tracking yet.
        expect(await impl.observerLedger.switchToTracking(gatekeeperId)).toBe(false);
        let session = await impl.openGatekeeperSession(
            gatekeeperId, await impl.getGatekeeperFacet(gatekeeperId), { from: "user" });
        let before = impl.storage.nextActionId.get();
        await session.read(trackedObservation(["simulated-id"], {
          containsRestrictedData: true, ownerInvitesOnly: true,
        }));
        expect(impl.storage.actions.get(before)).toMatchObject({
          gatekeeperId, type: "observation", state: "approved",
        });
        expect(impl.storage.actions.get(before).description.subresources).toBeUndefined();
        expect(impl.storage.nextActionId.get()).toBe(before + 1);
        expect(impl.storage.ownerInvitesOnly.get()).toBe(true);
        expect(() => impl.getWebFetchEnv()).toThrow(/observed sensitive data/);
        expect(impl.storage.gatekeepers.get(gatekeeperId).observerTracking).toBeUndefined();
        expect([...impl.storage.actions.byObserverRequirement.listKeys()]).toEqual([]);
        for (let role of ["build", "use"] as const) {
          expect(impl.listObserverRequirements(role)).toEqual([]);
          await impl.ensureObserver("carol", world.clientUser("carol"), role);
        }
        expect(world.checks).toEqual([]);
        expect(exports).toBe(0);
        expect(world.restarts).toEqual([]);
        expect(impl.gatekeeperUsable(gatekeeperId)).toBe(true);

        // Let the simulated collaborator session close so approval can be exercised in this DO
        // without its normal access restart quarantining the real connection until a reset.
        leave();
        let [creation] = impl.storage.actions.pendingByGatekeeper.get(gatekeeperId);
        await impl.applyPendingAction(creation,
            { type: "user", id: "owner", name: "Owner" }, false,
            { creator: {}, configuration: null });
        expect(impl.storage.actions.get(creation.id).state).toBe("approved");
        expect([...impl.storage.gatekeepers.list()].map((record: GatekeeperRecord) => record.id))
            .toEqual([gatekeeperId]);
        expect(impl.storage.gatekeepers.get(gatekeeperId)).toMatchObject({
          id: gatekeeperId, creationSpec: { resourceUrl: "https://example.com/real" },
        });
        // Approval makes it an existing connection advertising support. Its first tracked
        // observation, through a session opened before then, switches it and is checked and
        // recorded like any other; its (empty) history is imported exactly once.
        let staleSession = await impl.openGatekeeperSession(
            gatekeeperId, await impl.getGatekeeperFacet(gatekeeperId), { from: "user" });
        await staleSession.read(trackedObservation(["real-id"]));
        expect(impl.storage.gatekeepers.get(gatekeeperId).observerTracking).toBe(true);
        await impl.observerLedger.importHistory(gatekeeperId);
        expect(exports).toBe(1);
        expect(rows(impl, WORKSPACE)).toEqual([`${gatekeeperId}:real-id`]);
        expect(world.restarts).toEqual([]);
        expect(impl.gatekeeperUsable(gatekeeperId)).toBe(true);
      } finally {
        leave();
      }
    });

    await abortAllDurableObjects();

    await inOverseer(name, async world => {
      let { impl } = world;
      impl.getGatekeeperFacet = async () => facet();
      let realSession = await impl.openGatekeeperSession(
          gatekeeperId, await impl.getGatekeeperFacet(gatekeeperId), { from: "user" });

      world.roles.set("carol", "build");
      await impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll);
      world.verifiers.set("carol", observerVerifier(() => world, "carol", ids => ids));
      let beforeDenied = impl.storage.nextActionId.get();
      await expect(realSession.read(trackedObservation(["next-id"])))
          .rejects.toThrow(/could not be confirmed/);
      expect(impl.storage.nextActionId.get()).toBe(beforeDenied);
      expect(rows(impl, WORKSPACE)).toEqual([`${gatekeeperId}:real-id`]);
      world.verifiers.delete("carol");
      await realSession.read(trackedObservation(["next-id"]));
      expect(world.checks).toEqual([
        { profileId: "carol", ids: ["real-id"] },
        { profileId: "carol", ids: ["next-id"] },
        { profileId: "carol", ids: ["next-id"] },
      ]);
      expect(rows(impl, WORKSPACE))
          .toEqual([`${gatekeeperId}:next-id`, `${gatekeeperId}:real-id`]);
      expect(exports).toBe(1);
    });
  });

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
    await switchAndImport(impl, 3);
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
    await expect(impl.authorizeTrackedObservation(TRACKED, trackedObservation([second]),
        { from: "user" })).rejects.toThrow(/could not be confirmed/);
    expect(world.checks.at(-1)).toEqual({ profileId: "carol", ids: [second] });
    expect(rows(impl, WORKSPACE)).toEqual([`2:${first}`, `3:${second}`]);
    expect(impl.storage.nextActionId.get()).toBe(before);
  }));
});

describe("connection removal", () => {
  it.each(["build", "use"] as const)(
      "ignores a removed connection's retained requirements at %s admission, keeping its audit history across restarts",
      async role => {
    let name = `observer-ledger-removal-${++doCounter}`;
    let auditId = -1;
    let liveAuditId = -1;
    await inOverseer(name, async ({ impl }) => {
      seedTracked(impl);
      seedTracked(impl, 3);
      seedGadget(impl);
      auditId = impl.storage.nextActionId.get();
      await impl.authorizeTrackedObservation(TRACKED,
          trackedObservation(["removed/first"], { title: "Retained read" }), { from: "user" });
      liveAuditId = impl.storage.nextActionId.get();
      await impl.authorizeTrackedObservation(3, trackedObservation(["live/workspace"]),
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
        { profileId: "carol", ids: expect.arrayContaining(["live/workspace", "live/read"]) },
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
    await impl.authorizeTrackedObservation(TRACKED, trackedObservation(["read"]),
        { from: "agent", chatId: 1 }, "e1");

    expect(world.checks).toEqual([{ profileId: "bob", ids: ["read"] }]);
    expect(rows(impl, chat(1))).toEqual(["2:read"]);
    expect(rows(impl, chat(2))).toEqual(["2:other-chat"]);
    expect(rows(impl, gadget(GADGET))).toEqual(["2:gadget"]);
    expect(rows(impl, WORKSPACE)).toEqual(["2:workspace"]);

    impl.isLiveExecution = () => false;
    let before = impl.storage.nextActionId.get();
    await expect(impl.authorizeTrackedObservation(TRACKED, trackedObservation(["late"]),
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
    let read = impl.authorizeTrackedObservation(TRACKED, trackedObservation(["X"]),
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
    let read = impl.authorizeTrackedObservation(TRACKED, trackedObservation(["private"]),
        { from: "user", chatId: 1 });
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
    await impl.authorizeTrackedObservation(TRACKED, trackedObservation(["first"]), caller);
    await impl.authorizeTrackedObservation(TRACKED, trackedObservation(["second"]), caller);

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

    await expect(impl.authorizeTrackedObservation(TRACKED, trackedObservation(["denied"]),
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
    await expect(impl.authorizeTrackedObservation(TRACKED, trackedObservation(["x"]),
        { from: "gadget", chatId: 1 })).rejects.toThrow(/no attributable chat or gadget/);

    expect([...impl.storage.actions.byObserverRequirement.listKeys()]).toEqual([]);
    expect(impl.storage.nextActionId.get()).toBe(before);
  }));
});
