// Kernel-owned observer requirements (observer-ledger.ts), decided per observation. A read that
// reports ObservationDescription.subresources is checked against every collaborator who can see
// its context, through the connection's own verifyObserverAccess() handed each observer's
// verifier -- failing closed on every malformed or failed answer -- and is then recorded as a
// requirement. A read omitting them is checked by nothing here: the gatekeeper's addObserver()
// and excludeObservers cover it, as they always have. Admission is additive: every in-scope
// connection's addObserver(), plus its verifyObserverAccess() for the requirements recorded
// through it that the collaborator's role reaches.
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
  observerContextOf, type GatekeeperCaller, type GatekeeperRecord, type ObserverContext,
} from "../src/storage-schema/overseer-storage.js";
import { openFakeOverseer } from "./fixtures.js";
import type { BoundHookRecord } from "../src/storage-schema/overseer-storage.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const CONN = 2;
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

// A connection's verifyObserverAccess(): asks every observer's own verifier at once, and allows
// each one whose verifier denies none of `ids`.
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
    fakeFacets(world.impl);
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

function seedConnection(impl: ObserverImpl, id = CONN): void {
  impl.storage.gatekeepers.put({
    id, resourceTitle: `Connection ${id}`, class: fakeGatekeeperClass,
    creationSpec: spec("vendor", id),
  });
}

// `bindings` maps binding names to connection ids; a bound connection is in "use" scope.
function seedGadget(impl: ObserverImpl, id = GADGET, bindings: Record<string, number> = {}): void {
  impl.storage.gadgets.put({
    type: "gadget", id, title: "G", created: new Date(0), bindingName: `G${id}`,
    bindings: Object.fromEntries(Object.entries(bindings).map(([name, target]) => [name, { target }])),
  });
}

// Requirements are observation audit records that kept their subresources, attributed to a
// context by their caller.
function addRows(impl: ObserverImpl, context: ObserverContext, gatekeeperId: number, ids: string[]): void {
  let caller: GatekeeperCaller = context.type === "chat" ? { from: "agent", chatId: context.chatId }
      : context.type === "gadget" ? { from: "gadget", gadgetId: context.gadgetId }
      : { from: "user" };
  let id = impl.storage.nextActionId.get();
  impl.storage.nextActionId.put(id + 1);
  impl.storage.actions.put({
    id, gatekeeperId, caller, createdAt: new Date(0), state: "approved",
    type: "observation", description: withSubresources(ids),
  });
}

// Every subresource recorded as a requirement on `context`, whether or not its connection still
// exists: the observation records that kept their subresources, attributed by their caller.
function rows(impl: ObserverImpl, context: ObserverContext): string[] {
  let found = new Set<string>();
  for (let record of impl.storage.actions.list()) {
    if (record.type !== "observation" || !record.description.subresources) continue;
    if (JSON.stringify(observerContextOf(record.caller)) !== JSON.stringify(context)) continue;
    for (let id of record.description.subresources) found.add(`${record.gatekeeperId}:${id}`);
  }
  return [...found].toSorted();
}

// What admission requires of `role` through every connection in the workspace.
function requirements(impl: ObserverImpl, role: "build" | "use"): Map<number, string[]> {
  return impl.observerLedger.observerScope(role, Array.from(impl.storage.gatekeepers.list()))
      .requirements;
}

// One observer-protocol call a fake facet received.
type FacetCall = {
  method: "addObserver" | "removeObserver" | "verifyObserverAccess",
  gatekeeperId: number,
  observerIds: string[],
};

// The connections `method` was called on, in call order.
function callsTo(calls: FacetCall[], method: FacetCall["method"]): number[] {
  return calls.filter(call => call.method === method).map(call => call.gatekeeperId);
}

// Every connection's facet: addObserver() accepts unless `addObserver` throws, removeObserver()
// accepts, and verifyObserverAccess() asks each observer's verifier unless `verify` replaces it
// (null removes it). Every call is logged to `calls`.
function fakeFacets(impl: any, opts: {
  calls?: FacetCall[],
  addObserver?: (gatekeeperId: number) => void | Promise<void>,
  verify?: VerifyObserverAccess | null,
} = {}): void {
  impl.getGatekeeperFacet = async (id: number) => ({
    ...(opts.verify === null ? {} : {
      verifyObserverAccess: async (observers: ObserverToCheck[], ids: string[]) => {
        opts.calls?.push({
          method: "verifyObserverAccess", gatekeeperId: id,
          observerIds: observers.map(observer => observer.id),
        });
        return await (opts.verify ?? verifyEachObserver)(observers, ids);
      },
    }),
    addObserver: async (observerId: string) => {
      opts.calls?.push({ method: "addObserver", gatekeeperId: id, observerIds: [observerId] });
      await opts.addObserver?.(id);
    },
    removeObserver: async (observerId: string) => {
      opts.calls?.push({ method: "removeObserver", gatekeeperId: id, observerIds: [observerId] });
    },
  });
}

describe("observation persistence", () => {
  it("rolls back policy changes and the action ID when the audit write fails", () =>
      withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
    let sharing = await impl.getSharingManager();
    // A collaborator who joined through a link loses access once the owner invites only directly.
    sharing.computeAffectedByOwnerInvitesOnly = () => ["link-user"];
    impl.getSharingManager = async () => sharing;
    let before = impl.storage.nextActionId.get();
    let put = impl.storage.actions.put.bind(impl.storage.actions);
    impl.storage.actions.put = () => { throw new Error("audit write failed"); };
    let read = () => impl.authorizeObservation(CONN,
        observation({ containsRestrictedData: true, ownerInvitesOnly: true }), { from: "user" });
    try {
      await expect(read()).rejects.toThrow("audit write failed");
    } finally {
      impl.storage.actions.put = put;
    }
    expect(impl.storage.nextActionId.get()).toBe(before);
    expect(impl.storage.containsRestrictedData.get()).toBeFalsy();
    expect(impl.storage.ownerInvitesOnly.get()).toBeFalsy();

    // Nothing latched, so the retried read still revokes the link-joined collaborator.
    await read();
    expect(impl.storage.ownerInvitesOnly.get()).toBe(true);
    expect(world.restarts).toHaveLength(1);
  }));
});

const configureAll = {
  configure: async (needs: { gatekeeperId: number }[]) =>
      needs.map(need => ({ gatekeeperId: need.gatekeeperId, accountId: need.gatekeeperId * 10 })),
} as any;

function observation(extra: Partial<ObservationDescription> = {}): ObservationDescription {
  return { title: "Read", description: "A read", ...extra };
}

// An observation reporting `subresources`.
function withSubresources(subresources: string[],
                          extra: Partial<ObservationDescription> = {}): ObservationDescription {
  return observation({ ...extra, subresources });
}

// Only controller/callback capabilities are faked; the hook row, ledger, and action log use
// real DO storage. Functions cannot be structured-cloned, so attach capabilities on reads.
async function startHookFiring(world: World, gadgetId?: number) {
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
    id: 5, actionId: 999, gatekeeperId: CONN, vendorId: "vendor", gadgetId,
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

describe("hook observations", () => {
  it.each([
    { hookGadget: undefined, defaultGadget: undefined, context: WORKSPACE },
    { hookGadget: GADGET, defaultGadget: undefined, context: gadget(GADGET) },
    { hookGadget: undefined, defaultGadget: GADGET, context: gadget(GADGET) },
  ])("delivers through the firing queue and records requirements on the gadget it wakes " +
      "(hook gadgetId: $hookGadget, default gadget: $defaultGadget)",
      ({ hookGadget, defaultGadget, context }) => withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
    seedGadget(impl);
    impl.defaultGadgetId = defaultGadget;
    addRows(impl, gadget(GADGET), CONN, ["gadget-only"]);
    for (let [profileId, role] of [["bob", "build"], ["carol", "use"]] as const) {
      world.roles.set(profileId, role);
      impl.storage.observers.put(
          { profileId, observerId: `obs-${profileId}`, accountChoices: { [CONN]: 20 } });
    }
    using firing = await startHookFiring(world, hookGadget);
    let before = impl.storage.nextActionId.get();

    await firing.approvalQueue.authorizeObservation(withSubresources(["hook/event"]));
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
      gatekeeperId: CONN, type: "observation", state: "approved",
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
    seedConnection(impl);
    world.roles.set("carol", role);
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [CONN]: 20 } });
    world.verifiers.set("carol", observerVerifier(() => world, "carol", ids => ids));
    using firing = await startHookFiring(world);
    let before = impl.storage.nextActionId.get();
    let deliver = async () => {
      await firing.approvalQueue.authorizeObservation(withSubresources(["denied"]));
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
  // connection reachable from a "use" session, so only "build" collaborators are still verified
  // against it.
  for (let operation of ["disable", "delete"] as const) {
    it.each(["build", "use"] as const)(
        `retains delivered hook requirements after ${operation} and a DO restart (%s admission)`,
        async role => {
      let name = `observer-ledger-hook-history-${++doCounter}`;
      let auditId = -1;
      await inOverseer(name, async world => {
        let { impl } = world;
        seedConnection(impl);
        using firing = await startHookFiring(world);
        auditId = impl.storage.nextActionId.get();
        await firing.approvalQueue.authorizeObservation(withSubresources(["past/event"]));
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
        expect(requirements(impl, role).get(CONN)).toEqual(["past/event"]);
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
      seedConnection(impl);
      world.roles.set("carol", "use");
      impl.storage.observers.put(
          { profileId: "carol", observerId: "obs-c", accountChoices: { [CONN]: 20 } });
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
      using firing = await startHookFiring(world,
          operation === "restart" ? pendingGadget : undefined);
      let before = impl.storage.nextActionId.get();
      let authorize = firing.approvalQueue.authorizeObservation(withSubresources(
          ["racing/event"], { containsRestrictedData: true, ownerInvitesOnly: true }))
          .then(() => ({ authorized: true, error: "" }),
          error => ({ authorized: false, error: String(error) }));
      await checking;
      let refusal = operation === "restart" ? /restarting/ : /deleted or disabled/;
      if (operation === "restart") {
        // Binding it while a "use" session is live widens that session's scope, so the workspace
        // restarts and holds the connection back until the reset lands.
        using _session = { [Symbol.dispose]: impl.joinSession("use") };
        impl.bindWorkpiece(GADGET, "C", CONN);
        expect(world.restarts).toHaveLength(1);
        expect(impl.gatekeeperUsable(CONN)).toBe(false);
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

describe("observations with and without subresources", () => {
  it("checks nothing and records no requirement for a read omitting them, still enforcing " +
      "excludeObservers", () => withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
    addRows(impl, WORKSPACE, CONN, ["a"]);
    let calls: FacetCall[] = [];
    fakeFacets(impl, { calls });
    world.roles.set("carol", "build");
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [CONN]: 20 } });
    // Carol could read none of it: only a read that reports subresources asks.
    world.verifiers.set("carol", observerVerifier(() => world, "carol", ids => ids));
    let before = impl.storage.nextActionId.get();

    await impl.authorizeObservation(CONN, observation(), { from: "user" });
    expect(calls).toEqual([]);
    expect(world.checks).toEqual([]);
    expect(impl.storage.actions.get(before)).toMatchObject({
      gatekeeperId: CONN, type: "observation", state: "approved",
    });
    expect(impl.storage.actions.get(before).description.subresources).toBeUndefined();
    expect(requirements(impl, "build").get(CONN)).toEqual(["a"]);
    expect(rows(impl, WORKSPACE)).toEqual(["2:a"]);

    // The gatekeeper's own exclusion still blocks it.
    await expect(impl.authorizeObservation(CONN,
        observation({ excludeObservers: ["obs-c"] }), { from: "user" }))
        .rejects.toThrow(/not permitted to see/);
    expect(impl.storage.nextActionId.get()).toBe(before + 1);
  }));

  it("records only the reads of a connection that report subresources as requirements", () =>
      withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
    let before = impl.storage.nextActionId.get();

    await impl.authorizeObservation(CONN, withSubresources(["reported"]), { from: "user" });
    await impl.authorizeObservation(CONN, observation(), { from: "user" });
    await impl.authorizeObservation(CONN, withSubresources(["also-reported"]), { from: "user" });

    expect(impl.storage.nextActionId.get()).toBe(before + 3);  // every read audited
    expect(requirements(impl, "build").get(CONN)?.toSorted())
        .toEqual(["also-reported", "reported"]);

    // Admission checks exactly those.
    world.roles.set("carol", "build");
    await impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll);
    expect(world.checks.map(check => ({ ...check, ids: check.ids.toSorted() }))).toEqual([
      { profileId: "carol", ids: ["also-reported", "reported"] },
    ]);
  }));

  it("enforces excludeObservers and subresources together on one read", () =>
      withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
    world.roles.set("carol", "build");
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [CONN]: 20 } });
    let before = impl.storage.nextActionId.get();

    // Carol can read it, but the gatekeeper names her and she still has access.
    await expect(impl.authorizeObservation(CONN,
        withSubresources(["x"], { excludeObservers: ["obs-c"] }), { from: "user" }))
        .rejects.toThrow(/not permitted to see/);
    expect(impl.storage.nextActionId.get()).toBe(before);

    // Nobody named can reach it, but Carol is denied the reported subresource.
    world.verifiers.set("carol", observerVerifier(() => world, "carol", ids => ids));
    await expect(impl.authorizeObservation(CONN,
        withSubresources(["x"], { excludeObservers: ["obs-unknown"] }), { from: "user" }))
        .rejects.toThrow(/could not be confirmed/);
    expect(impl.storage.nextActionId.get()).toBe(before);
    expect(rows(impl, WORKSPACE)).toEqual([]);

    // Both satisfied: authorized and recorded.
    world.verifiers.delete("carol");
    await impl.authorizeObservation(CONN,
        withSubresources(["x"], { excludeObservers: ["obs-unknown"] }), { from: "user" });
    expect(rows(impl, WORKSPACE)).toEqual(["2:x"]);
    expect(impl.storage.actions.get(before).description)
        .toMatchObject({ subresources: ["x"], excludeObservers: ["obs-unknown"] });
  }));

  it("audits an explicit [] without checking anyone or adding a requirement", () =>
      withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
    let calls: FacetCall[] = [];
    fakeFacets(impl, { calls });
    world.roles.set("carol", "build");
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [CONN]: 20 } });
    world.verifiers.set("carol", observerVerifier(() => world, "carol", ids => ids));
    let before = impl.storage.nextActionId.get();

    await impl.authorizeObservation(CONN, withSubresources([]), { from: "user" });

    expect(impl.storage.nextActionId.get()).toBe(before + 1);
    expect(impl.storage.actions.get(before).description.subresources).toEqual([]);
    expect(calls).toEqual([]);
    expect(world.checks).toEqual([]);
    expect(rows(impl, WORKSPACE)).toEqual([]);
    expect(requirements(impl, "build").size).toBe(0);
  }));
});

describe("observations reporting subresources", () => {
  it("refuse IDs that are not well-formed Unicode", () => withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
    let before = impl.storage.nextActionId.get();

    // Storage would turn both lone surrogates into the same replacement characters.
    await expect(impl.authorizeObservation(CONN,
        withSubresources(["doc:\uD800", "doc:\uDBFF"]), { from: "user" }))
        .rejects.toThrow(/well-formed/);
    expect(impl.storage.nextActionId.get()).toBe(before);
  }));

  it("refuse IDs that together exceed one observation's size limit", () => withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
    let before = impl.storage.nextActionId.get();
    let atLimit = Array.from({ length: 1_000 }, (_, i) => String(i).padStart(500, "界"));

    await expect(impl.authorizeObservation(CONN, withSubresources([...atLimit, "x"]),
        { from: "user" })).rejects.toThrow(/at most 500000 characters/);
    expect(impl.storage.nextActionId.get()).toBe(before);

    await impl.authorizeObservation(CONN, withSubresources(atLimit), { from: "user" });
    expect(requirements(impl, "build").get(CONN)?.toSorted()).toEqual(atLimit.toSorted());
  }));

  it.each(refusingAnswers)("fail closed on %s from the connection's access check",
      (_name, verify) => withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
    let calls: FacetCall[] = [];
    fakeFacets(impl, { calls, verify });
    world.roles.set("carol", "use");
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [CONN]: 20 } });
    let before = impl.storage.nextActionId.get();

    await expect(impl.authorizeObservation(CONN, withSubresources(["x", "y"]),
        { from: "user" }))
        .rejects.toThrow(/could not be confirmed/);
    expect(rows(impl, WORKSPACE)).toEqual([]);
    expect(impl.storage.nextActionId.get()).toBe(before);
    expect(callsTo(calls, "addObserver")).toEqual([]);
  }));

  it("check configured observers who are offline, but not ones who lost access", () =>
      withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
    world.roles.set("carol", "build");
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [CONN]: 20 } });
    impl.storage.observers.put(
        { profileId: "erin", observerId: "obs-e", accountChoices: { [CONN]: 21 } });
    // Erin is configured but no longer in the sharing graph; her denial must not block anything.
    world.verifiers.set("erin", observerVerifier(() => world, "erin", ids => ids));

    await impl.authorizeObservation(CONN, withSubresources(["x"]), { from: "user" });
    expect(world.checks).toEqual([{ profileId: "carol", ids: ["x"] }]);
    expect(rows(impl, WORKSPACE)).toEqual(["2:x"]);

    // A remembered ID is not a remembered grant: the next read checks it again.
    await impl.authorizeObservation(CONN, withSubresources(["x"]), { from: "user" });
    expect(world.checks).toHaveLength(2);
  }));

  it("refuse a read denied only by an observer past the first access-check call", () =>
      withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
    let calls: FacetCall[] = [];
    fakeFacets(impl, { calls });
    let profiles = Array.from({ length: 11 }, (_, i) => `p${String(i).padStart(2, "0")}`);
    for (let profileId of profiles) {
      world.roles.set(profileId, "build");
      impl.storage.observers.put(
          { profileId, observerId: `obs-${profileId}`, accountChoices: { [CONN]: 20 } });
    }
    world.verifiers.set("p10", observerVerifier(() => world, "p10", ids => ids));
    let before = impl.storage.nextActionId.get();

    await expect(impl.authorizeObservation(CONN, withSubresources(["x"]),
        { from: "user" })).rejects.toThrow(/could not be confirmed/);

    // Each call carries at most ten observers, so the denier is asked in a later one.
    let asked = calls.map(call => call.observerIds);
    expect(asked.every(ids => ids.length <= 10)).toBe(true);
    expect(asked.flat().toSorted()).toEqual(profiles.map(profileId => `obs-${profileId}`));
    expect(world.checks.map(check => check.profileId).toSorted()).toEqual(profiles);
    expect(rows(impl, WORKSPACE)).toEqual([]);
    expect(impl.storage.nextActionId.get()).toBe(before);
  }));

  it("does not admit a collaborator alongside an unreadable concurrent observation", () =>
      withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
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
        read ??= impl.authorizeObservation(CONN, withSubresources(["x"]),
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
    seedConnection(impl);
    world.roles.set("carol", "build");
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [CONN]: 20 } });
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
    let read = impl.authorizeObservation(CONN, withSubresources(["x"]),
        { from: "user" });
    await checking;
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [CONN]: 21 } });
    release();

    if (readable) await read;
    else await expect(read).rejects.toThrow(/could not be confirmed/);
    expect(accounts).toEqual([20, 21]);
    expect(rows(impl, WORKSPACE)).toEqual(readable ? ["2:x"] : []);
    expect(impl.storage.nextActionId.get()).toBe(before + (readable ? 1 : 0));
    if (!readable) expect(impl.storage.actions.get(before)).toBeUndefined();
  }));
});

describe("admission against recorded requirements", () => {
  it.each(["build", "use"] as const)(
      "admits %s collaborators against workspace and every reachable context", role =>
      withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
    seedGadget(impl, GADGET, { C: CONN });
    seedGadget(impl, GADGET + 1);
    addRows(impl, WORKSPACE, CONN, ["workspace"]);
    addRows(impl, chat(1), CONN, ["chat-one"]);
    addRows(impl, chat(2), CONN, ["chat-two"]);
    addRows(impl, gadget(GADGET), CONN, ["gadget-one"]);
    addRows(impl, gadget(GADGET + 1), CONN, ["gadget-two"]);
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
    expect(impl.storage.observers.get("carol").accountChoices).toEqual({ [CONN]: 20 });
  }));

  // Admission shares the observation path's answer validation (see refusingAnswers); a
  // verifyObserverAccess() denial is covered under "additive admission" below.
  it("fails closed when the chosen account's verifier can't be looked up", () =>
      withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
    addRows(impl, WORKSPACE, CONN, ["a"]);
    let calls: FacetCall[] = [];
    fakeFacets(impl, { calls });
    world.roles.set("carol", "build");
    world.verifiers.set("carol", new Error("Invalid account selection for this service."));
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [CONN]: 20 } });

    let admission = impl.ensureObserver("carol", world.clientUser("carol"), "build");
    await expect(admission).rejects.toThrow(/could not confirm/);
    await expect(admission).rejects.toThrow(/Invalid account selection/);
    expect(callsTo(calls, "addObserver")).toEqual([]);
    expect(callsTo(calls, "verifyObserverAccess")).toEqual([]);
  }));

  it("re-verifies when a requirement lands while the account prompt is open", () =>
      withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
    addRows(impl, WORKSPACE, CONN, ["a"]);
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
    await impl.authorizeObservation(CONN, withSubresources(["b"]), { from: "user" });
    expect(world.checks).toEqual([]);
    release();
    await admission;

    expect(world.checks.at(-1)).toEqual({ profileId: "carol", ids: ["a", "b"] });
    expect(impl.storage.observers.get("carol").accountChoices).toEqual({ [CONN]: 20 });
  }));

  it("blocks an in-flight observation that a newly admitted collaborator cannot access", () =>
      withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
    world.roles.set("carol", "build");
    world.roles.set("dave", "build");
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [CONN]: 20 } });
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

    let read = impl.authorizeObservation(CONN, withSubresources(["x"]),
        { from: "user" });
    await checking;
    // Dave's admission publishes while Carol's check is in flight.
    impl.storage.observers.put(
        { profileId: "dave", observerId: "obs-d", accountChoices: { [CONN]: 30 } });
    release();
    await expect(read).rejects.toThrow(/could not be confirmed/);
    expect(rows(impl, WORKSPACE)).toEqual([]);
    expect(impl.storage.nextActionId.get()).toBe(before);
    expect(impl.storage.actions.get(before)).toBeUndefined();
  }));

  it("asks use collaborators for no account for a connection nothing binds or hooks", () =>
      withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
    addRows(impl, chat(1), CONN, ["chat-only"]);
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
    expect(asked).toEqual([[CONN]]);
    expect(world.checks).toEqual([{ profileId: "dave", ids: ["chat-only"] }]);
  }));

  it("ignores reads outside a use collaborator's scope that land while she is verified", () =>
      withWorld(async world => {
    let { impl } = world;
    let unbound = CONN + 1;
    seedConnection(impl);
    seedConnection(impl, unbound);
    seedGadget(impl, GADGET, { C: CONN });
    addRows(impl, WORKSPACE, CONN, ["bound"]);
    fakeFacets(impl);
    world.roles.set("carol", "use");
    let reads = 0;
    world.verifiers.set("carol", observerVerifier(() => world, "carol", async () => {
      // The owner keeps reading through a connection nothing binds while Carol is checked.
      await impl.authorizeObservation(unbound,
          withSubresources([`unbound-${++reads}`]), { from: "user" });
      return [];
    }));

    await impl.ensureObserver("carol", world.clientUser("carol"), "use", configureAll);

    expect(world.checks).toEqual([{ profileId: "carol", ids: ["bound"] }]);
    expect(impl.storage.observers.get("carol").accountChoices).toEqual({ [CONN]: 20 });
  }));

  it("verifies existing reads through a connection that enters a use scope mid-verification", () =>
      withWorld(async world => {
    let { impl } = world;
    let later = CONN + 1;
    seedConnection(impl);
    seedConnection(impl, later);
    seedGadget(impl, GADGET, { C: CONN });
    addRows(impl, WORKSPACE, CONN, ["bound"]);
    addRows(impl, WORKSPACE, later, ["secret"]);
    fakeFacets(impl);
    world.roles.set("carol", "use");
    world.verifiers.set("carol", observerVerifier(() => world, "carol", ids => {
      // Binding the connection widens the scope while she is being checked.
      seedGadget(impl, GADGET, { C: CONN, D: later });
      return ids.filter(id => id === "secret");
    }));

    await expect(impl.ensureObserver("carol", world.clientUser("carol"), "use", configureAll))
        .rejects.toThrow(/could not confirm/);
    expect(world.checks).toContainEqual({ profileId: "carol", ids: ["secret"] });
    expect(impl.storage.observers.get("carol")).toBeUndefined();
  }));

  it("admits against live requirements when an observed connection is removed during its prompt",
      () => withWorld(async world => {
    let { impl } = world;
    let removed = CONN - 1;
    seedConnection(impl, removed);
    seedConnection(impl);
    addRows(impl, WORKSPACE, removed, ["gone"]);
    addRows(impl, WORKSPACE, CONN, ["live"]);
    let calls: FacetCall[] = [];
    fakeFacets(impl, { calls });
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
    impl.removeGatekeeper(removed);
    release();
    await admission;

    // Nothing reached the removed connection, and only the live requirement was checked.
    expect(calls.filter(call => call.gatekeeperId === removed)).toEqual([]);
    expect(world.checks.flatMap(check => check.ids)).toContain("live");
    expect(world.checks.flatMap(check => check.ids)).not.toContain("gone");
    expect(impl.storage.observers.get("carol").accountChoices[CONN]).toBe(20);
  }));

  it("checks accumulated requirements beyond one call's limit in batches", () =>
      withWorld(async world => {
    let { impl } = world;
    let ids = Array.from({ length: 10_001 }, (_, i) => String(i));
    seedConnection(impl);
    // One observation is held to its own limit, so the requirement accumulates over two.
    await expect(impl.authorizeObservation(CONN, withSubresources(ids), { from: "user" }))
        .rejects.toThrow(/at most 10000/);
    expect(requirements(impl, "build").size).toBe(0);
    await impl.authorizeObservation(CONN, withSubresources(ids.slice(0, 10_000)), { from: "user" });
    await impl.authorizeObservation(CONN, withSubresources(ids.slice(10_000)), { from: "user" });
    let required = requirements(impl, "build").get(CONN)!;
    expect(required.toSorted()).toEqual(ids.toSorted());

    world.roles.set("carol", "build");
    world.verifiers.set("carol", observerVerifier(() => world, "carol",
        batch => batch.filter(id => id === required.at(-1))));
    await expect(impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll))
        .rejects.toThrow(/could not confirm/);
    expect(world.checks).toContainEqual({ profileId: "carol", ids: required.slice(10_000) });
    expect(impl.storage.observers.get("carol")).toBeUndefined();

    world.verifiers.delete("carol");
    await impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll);
    expect(impl.storage.observers.get("carol").accountChoices).toEqual({ [CONN]: 20 });
  }));

  it("verifies fully qualified IDs without conflating same-named resources", () =>
      withWorld(async world => {
    let { impl } = world;
    let first = "workspace-a/documents/shared";
    let second = "workspace-b/documents/shared";
    seedConnection(impl);
    seedConnection(impl, 3);
    addRows(impl, WORKSPACE, CONN, [first]);
    addRows(impl, WORKSPACE, 3, [second]);
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
    await expect(impl.authorizeObservation(CONN, withSubresources([second]),
        { from: "user" })).rejects.toThrow(/could not be confirmed/);
    expect(world.checks.at(-1)).toEqual({ profileId: "carol", ids: [second] });
    expect(rows(impl, WORKSPACE)).toEqual([`2:${first}`, `3:${second}`]);
    expect(impl.storage.nextActionId.get()).toBe(before);
  }));
});

describe("additive admission", () => {
  it("denies an addObserver refusal with no recorded requirements, never asking " +
      "verifyObserverAccess", () => withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
    let calls: FacetCall[] = [];
    fakeFacets(impl, {
      calls,
      addObserver: () => { throw new Error("This account can't read the sheet."); },
    });
    world.roles.set("carol", "build");

    await expect(impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll))
        .rejects.toThrow(/Connection 2 .*can't read the sheet/);
    expect(callsTo(calls, "addObserver")).toContain(CONN);
    expect(callsTo(calls, "verifyObserverAccess")).toEqual([]);
    expect(impl.storage.observers.get("carol")).toBeUndefined();
  }));

  it("denies a recorded requirement the account can't read even though addObserver accepted",
      () => withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
    addRows(impl, WORKSPACE, CONN, ["a"]);
    let calls: FacetCall[] = [];
    fakeFacets(impl, { calls });
    world.roles.set("carol", "build");
    world.verifiers.set("carol", observerVerifier(() => world, "carol", ids => ids));
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [CONN]: 20 } });

    let admission = impl.ensureObserver("carol", world.clientUser("carol"), "build");
    await expect(admission).rejects.toThrow(/could not confirm/);
    await expect(admission).rejects.toThrow(/can't access some of the data/);
    expect(callsTo(calls, "addObserver")).toEqual([CONN]);
    expect(world.checks).toEqual([{ profileId: "carol", ids: ["a"] }]);
    // A returning observer keeps her registrations and her record.
    expect(callsTo(calls, "removeObserver")).toEqual([]);
    expect(impl.storage.observers.get("carol"))
        .toEqual({ profileId: "carol", observerId: "obs-c", accountChoices: { [CONN]: 20 } });
  }));

  it("removes a first-time observer's registrations when the requirement check refuses her", () =>
      withWorld(async world => {
    let { impl } = world;
    let unrecorded = CONN - 1;
    seedConnection(impl, unrecorded);
    seedConnection(impl);
    addRows(impl, WORKSPACE, CONN, ["a"]);
    let calls: FacetCall[] = [];
    fakeFacets(impl, { calls });
    world.roles.set("carol", "build");
    world.verifiers.set("carol", observerVerifier(() => world, "carol", ids => ids));

    await expect(impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll))
        .rejects.toThrow(/can't access some of the data/);
    // Both connections' addObserver() accepted her, but every registration this call made is
    // removed under the observer ID it registered, and nothing persists.
    expect(impl.storage.observers.get("carol")).toBeUndefined();
    let added = calls.filter(call => call.method === "addObserver");
    let removed = calls.filter(call => call.method === "removeObserver");
    expect([...new Set(callsTo(calls, "addObserver"))].toSorted()).toEqual([unrecorded, CONN]);
    expect(callsTo(calls, "removeObserver").toSorted()).toEqual([unrecorded, CONN]);
    expect(new Set(removed.flatMap(call => call.observerIds)))
        .toEqual(new Set(added.flatMap(call => call.observerIds)));
  }));

  it("asks verifyObserverAccess only of connections with recorded requirements", () =>
      withWorld(async world => {
    let { impl } = world;
    let unrecorded = 1;
    seedConnection(impl, unrecorded);
    seedConnection(impl);
    addRows(impl, WORKSPACE, CONN, ["a"]);
    // A read omitting subresources records nothing to check either.
    await impl.authorizeObservation(unrecorded, observation(), { from: "user" });
    let calls: FacetCall[] = [];
    fakeFacets(impl, { calls });
    world.roles.set("carol", "build");

    await impl.ensureObserver("carol", world.clientUser("carol"), "build", configureAll);

    // Every connection registered her; only the one with requirements checked them.
    expect(callsTo(calls, "addObserver").toSorted()).toEqual([unrecorded, CONN]);
    expect(callsTo(calls, "verifyObserverAccess")).toEqual([CONN]);
    expect(world.checks).toEqual([{ profileId: "carol", ids: ["a"] }]);
    let record = impl.storage.observers.get("carol");
    expect(record.accountChoices).toEqual({ [unrecorded]: 10, [CONN]: 20 });
    // Both gates ran for the identity that was then persisted.
    expect(new Set(calls.flatMap(call => call.observerIds))).toEqual(new Set([record.observerId]));

    // The gatekeeper still names observers to exclude, and is still blocked by them.
    await expect(impl.authorizeObservation(unrecorded,
        observation({ excludeObservers: [record.observerId] }), { from: "user" }))
        .rejects.toThrow(/not permitted to see/);
  }));
});

describe("pending creation", () => {
  it("audits simulated reads without external permissions, then checks the approved real resource",
      async () => {
    let name = `observer-ledger-creation-${++doCounter}`;
    let real = false;
    let gatekeeperId!: number;
    let facet = () => ({
      describe: async () => ({
        url: `https://example.com/${real ? "real" : "simulated"}`,
        title: real ? "Real" : "Simulated", snippet: "", suggestedBindingName: "N", tsType: "N",
      }),
      verifyObserverAccess: verifyEachObserver,
      addObserver: async () => {},
      removeObserver: async () => {},
      applyCreation: async () => {
        real = true;
        return { class: {}, resourceUrl: "https://example.com/real" };
      },
      startSession: async (queue: ObservationAuthorizer) => ({
        read: (description: ObservationDescription) => queue.authorizeObservation(description),
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
          vendorId: "vendor", resourceUrlPattern: "https://example.com/*", title: "New",
          bindingName: "N",
        }));
        let session = await impl.openGatekeeperSession(
            gatekeeperId, await impl.getGatekeeperFacet(gatekeeperId), { from: "user" });
        let before = impl.storage.nextActionId.get();
        await session.read(withSubresources(["simulated-id"], {
          containsRestrictedData: true, ownerInvitesOnly: true,
        }));
        expect(impl.storage.actions.get(before)).toMatchObject({
          gatekeeperId, type: "observation", state: "approved",
        });
        expect(impl.storage.actions.get(before).description.subresources).toBeUndefined();
        expect(impl.storage.nextActionId.get()).toBe(before + 1);
        expect(impl.storage.ownerInvitesOnly.get()).toBe(true);
        expect(() => impl.getWebFetchEnv()).toThrow(/observed sensitive data/);
        for (let role of ["build", "use"] as const) {
          expect(impl.listObserverRequirements(role)).toEqual([]);
          await impl.ensureObserver("carol", world.clientUser("carol"), role);
        }
        expect(world.checks).toEqual([]);
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
        // Once approved, a read reporting subresources is checked and recorded like any other.
        let approvedSession = await impl.openGatekeeperSession(
            gatekeeperId, await impl.getGatekeeperFacet(gatekeeperId), { from: "user" });
        await approvedSession.read(withSubresources(["real-id"]));
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
      await expect(realSession.read(withSubresources(["next-id"])))
          .rejects.toThrow(/could not be confirmed/);
      expect(impl.storage.nextActionId.get()).toBe(beforeDenied);
      expect(rows(impl, WORKSPACE)).toEqual([`${gatekeeperId}:real-id`]);
      world.verifiers.delete("carol");
      await realSession.read(withSubresources(["next-id"]));
      expect(world.checks).toEqual([
        { profileId: "carol", ids: ["real-id"] },
        { profileId: "carol", ids: ["next-id"] },
        { profileId: "carol", ids: ["next-id"] },
      ]);
      expect(rows(impl, WORKSPACE))
          .toEqual([`${gatekeeperId}:next-id`, `${gatekeeperId}:real-id`]);
    });
  });
});

describe("connection removal", () => {
  it.each(["build", "use"] as const)(
      "ignores a removed connection's retained requirements at %s admission, keeping its audit history across restarts",
      async role => {
    let name = `observer-ledger-removal-${++doCounter}`;
    let auditId = -1;
    let liveAuditId = -1;
    await inOverseer(name, async ({ impl }) => {
      seedConnection(impl);
      seedConnection(impl, 3);
      seedGadget(impl);
      auditId = impl.storage.nextActionId.get();
      await impl.authorizeObservation(CONN,
          withSubresources(["removed/first"], { title: "Retained read" }), { from: "user" });
      liveAuditId = impl.storage.nextActionId.get();
      await impl.authorizeObservation(3, withSubresources(["live/workspace"]),
          { from: "user" });
      for (let context of [WORKSPACE, chat(1), chat(99), gadget(GADGET), gadget(999)]) {
        addRows(impl, context, CONN, ["removed/read"]);
        addRows(impl, context, 3, ["live/read"]);
      }
      impl.bindWorkpiece(GADGET, "REMOVED", CONN);
      impl.bindWorkpiece(GADGET, "LIVE", 3);

      impl.removeGatekeeper(CONN);

      expect(impl.storage.gatekeepers.get(CONN)).toBeUndefined();
      expect(impl.storage.gatekeepers.get(3)).toBeDefined();
      // The removed connection's records stay in the audit log.
      for (let context of [chat(1), chat(99), gadget(GADGET), gadget(999)]) {
        expect(rows(impl, context)).toEqual(["2:removed/read", "3:live/read"]);
      }
      expect(impl.storage.gadgets.get(GADGET).bindings).toEqual({ LIVE: { target: 3 } });
      expect(impl.storage.actions.get(auditId)).toMatchObject({
        gatekeeperId: CONN, type: "observation", state: "approved",
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
      expect(impl.storage.gatekeepers.get(CONN)).toBeUndefined();
      expect(impl.storage.actions.get(auditId)).toMatchObject({
        gatekeeperId: CONN, description: { subresources: ["removed/first"] },
      });
      expect(impl.storage.actions.get(liveAuditId).gatekeeperId).toBe(3);
    });
  });
});

describe("direct context authorization", () => {
  it("records chat reads only in that chat and checks build, not use, collaborators", () =>
      withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
    seedGadget(impl);
    addRows(impl, WORKSPACE, CONN, ["workspace"]);
    addRows(impl, gadget(GADGET), CONN, ["gadget"]);
    addRows(impl, chat(2), CONN, ["other-chat"]);
    world.roles.set("bob", "build");
    world.roles.set("carol", "use");
    for (let profileId of ["bob", "carol"]) {
      impl.storage.observers.put(
          { profileId, observerId: `obs-${profileId}`, accountChoices: { [CONN]: 20 } });
    }
    world.verifiers.set("carol", observerVerifier(() => world, "carol", ids => ids));

    impl.isLiveExecution = (chatId: number, id: string) => chatId === 1 && id === "e1";
    await impl.authorizeObservation(CONN, withSubresources(["read"]),
        { from: "agent", chatId: 1 }, "e1");

    expect(world.checks).toEqual([{ profileId: "bob", ids: ["read"] }]);
    expect(rows(impl, chat(1))).toEqual(["2:read"]);
    expect(rows(impl, chat(2))).toEqual(["2:other-chat"]);
    expect(rows(impl, gadget(GADGET))).toEqual(["2:gadget"]);
    expect(rows(impl, WORKSPACE)).toEqual(["2:workspace"]);

    impl.isLiveExecution = () => false;
    let before = impl.storage.nextActionId.get();
    await expect(impl.authorizeObservation(CONN, withSubresources(["late"]),
        { from: "agent", chatId: 1 }, "e1"))
        .rejects.toThrow(/has ended/);
    expect(rows(impl, chat(1))).toEqual(["2:read"]);
    expect(impl.storage.nextActionId.get()).toBe(before);
    // The fence covers only reads reporting subresources; one omitting them is unaffected.
    await impl.authorizeObservation(CONN, observation(), { from: "agent", chatId: 1 }, "e1");
    expect(impl.storage.nextActionId.get()).toBe(before + 1);
    expect(rows(impl, chat(1))).toEqual(["2:read"]);
  }));

  it("refuses a read whose execution ends while observer verification is in flight", () =>
      withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
    world.roles.set("bob", "build");
    impl.storage.observers.put(
        { profileId: "bob", observerId: "obs-b", accountChoices: { [CONN]: 20 } });
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
    let read = impl.authorizeObservation(CONN, withSubresources(["X"]),
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
    seedConnection(impl);
    world.roles.set("bob", "build");
    world.roles.set("carol", "use");
    for (let profileId of ["bob", "carol"]) {
      impl.storage.observers.put(
          { profileId, observerId: `obs-${profileId}`, accountChoices: { [CONN]: 20 } });
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
    let read = impl.authorizeObservation(CONN, withSubresources(["private"]),
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
    seedConnection(impl);
    seedGadget(impl);
    seedGadget(impl, GADGET + 1);
    addRows(impl, WORKSPACE, CONN, ["workspace"]);
    addRows(impl, chat(1), CONN, ["chat"]);
    addRows(impl, gadget(GADGET), CONN, ["other-gadget"]);
    addRows(impl, gadget(GADGET + 1), CONN, ["retained"]);
    world.roles.set("bob", "build");
    world.roles.set("carol", "use");
    for (let profileId of ["bob", "carol"]) {
      impl.storage.observers.put(
          { profileId, observerId: `obs-${profileId}`, accountChoices: { [CONN]: 20 } });
    }

    impl.bindWorkpiece(GADGET + 1, "DB", CONN);
    expect(impl.storage.gadgets.get(GADGET + 1).bindings.DB).toEqual({ target: CONN });
    impl.storage.defaultGadgetId.put(GADGET);
    let caller = { from: "gadget", chatId: 1, gadgetId: GADGET + 1 };
    await impl.authorizeObservation(CONN, withSubresources(["first"]), caller);
    await impl.authorizeObservation(CONN, withSubresources(["second"]), caller);

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
    seedConnection(impl);
    seedGadget(impl);
    addRows(impl, gadget(GADGET), CONN, ["retained"]);
    world.roles.set("carol", role);
    impl.storage.observers.put(
        { profileId: "carol", observerId: "obs-c", accountChoices: { [CONN]: 20 } });
    world.verifiers.set("carol", observerVerifier(() => world, "carol", ids => ids));
    let before = impl.storage.nextActionId.get();

    await expect(impl.authorizeObservation(CONN, withSubresources(["denied"]),
        { from: "gadget", gadgetId: GADGET }))
        .rejects.toThrow(/could not be confirmed/);

    expect(world.checks).toEqual([{ profileId: "carol", ids: ["denied"] }]);
    expect(rows(impl, gadget(GADGET))).toEqual(["2:retained"]);
    expect(rows(impl, WORKSPACE)).toEqual([]);
    expect(impl.storage.nextActionId.get()).toBe(before);
    expect(impl.storage.actions.get(before)).toBeUndefined();
  }));

  it("refuses observations reporting subresources with no attributable context", () =>
      withWorld(async world => {
    let { impl } = world;
    seedConnection(impl);
    fakeFacets(impl);
    impl.storage.defaultGadgetId.put(GADGET);
    let before = impl.storage.nextActionId.get();

    // A gadget caller persisted before multi-gadget support has no gadgetId. Even a default
    // gadget and chatId do not make that historical caller attributable.
    await expect(impl.authorizeObservation(CONN, withSubresources(["x"]),
        { from: "gadget", chatId: 1 })).rejects.toThrow(/no attributable chat or gadget/);

    expect(impl.storage.nextActionId.get()).toBe(before);
  }));
});
