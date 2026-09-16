// Forward exclusion (`ObservationDescription.excludeObservers`) blocks an observation when a named
// observer could see it. A "use" collaborator only ever sees what a gadget binds, so a connection
// no gadget binds any more is outside their verification scope -- and their registration on it,
// which their opens no longer touch, must not go on blocking observations they could not reach.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// observer-scope-restart.test.ts).

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER = "owner";
const CAROL = "carol";
const OBSERVER_ID = "obs-carol";
const GATEKEEPER_ID = 1;

let doCounter = 0;

// Removals the gatekeeper facets saw, as `${gatekeeperId}:${observerId}`.
type Removals = string[];

async function withImpl(
    role: "build" | "use" | null,
    fn: (impl: any, removals: Removals) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`observer-exclude-scope-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerProfileId = OWNER;
    // Carol's role in the permission graph. Stubbed rather than seeded through the sharing table so
    // the "lost access entirely" case needs no revocation plumbing.
    impl.getSharingManager = async () => ({
      getEffectiveRole: (profileId: string) => profileId === CAROL ? role : null,
      hasAnyShares: () => role !== null,
    });

    let removals: Removals = [];
    impl.getGatekeeperFacet = (id: number) => ({
      removeObserver: async (observerId: string) => { removals.push(`${id}:${observerId}`); },
    });

    impl.storage.gatekeepers.put({
      id: GATEKEEPER_ID,
      resourceTitle: "Connection",
      class: {} as any,
      creationSpec: {
        type: "gatekeeper",
        vendorId: "testvendor",
        resourceUrl: "https://example.com/1",
        typeUrlPattern: "https://*",
      },
    });
    impl.storage.observers.put(
        { profileId: CAROL, observerId: OBSERVER_ID, accountChoices: { [GATEKEEPER_ID]: 10 } });

    await fn(impl, removals);
  });
}

// A gadget holding a permanent edge onto the connection, which is what puts it in "use" scope.
function bindIntoGadget(impl: any): void {
  impl.storage.gadgets.put(
      { type: "gadget", id: 100, title: "G", created: new Date(0), bindingName: "G", bindings: {} });
  impl.bindWorkpiece(100, "DB", GATEKEEPER_ID);
}

const DESCRIPTION: ObservationDescription = {
  title: "Observation",
  description: "An observation the gatekeeper says Carol must not see",
  excludeObservers: [OBSERVER_ID],
};

const CALLER = { from: "agent", chatId: 1 } as const;

function observe(impl: any): Promise<void> {
  return impl.authorizeObservation(GATEKEEPER_ID, DESCRIPTION, CALLER);
}

describe("excludeObservers against the observer's verification scope", () => {
  it("a use collaborator does not block an observation from an unbound connection",
      () => withImpl("use", async (impl, removals) => {
    // No gadget binds the connection, so it is outside Carol's scope: her open never verified her
    // against it and she has no way to see what it produces.
    await observe(impl);

    // She is de-registered from exactly this gatekeeper, so it stops naming her. Her record --
    // which is what makes her observerId resolvable at all -- survives: she is still a
    // collaborator, and a rebind must put her back in scope rather than start her from scratch.
    expect(removals).toEqual([`${GATEKEEPER_ID}:${OBSERVER_ID}`]);
    expect(impl.storage.observers.get(CAROL)).toBeDefined();
    expect(impl.storage.observers.byObserverId.get(OBSERVER_ID)).toBeDefined();
  }));

  it("a use collaborator blocks an observation from a connection a gadget binds",
      () => withImpl("use", async (impl, removals) => {
    bindIntoGadget(impl);

    await expect(observe(impl)).rejects.toThrow(/not permitted to see/);

    // A blocked observation leaves no teardown behind it.
    expect(removals).toEqual([]);
    expect(impl.storage.observers.get(CAROL)).toBeDefined();
  }));

  it("a build collaborator blocks whether or not a gadget binds the connection",
      () => withImpl("build", async (impl, removals) => {
    // "build" scope is every account-requiring connection, bound or not, so an unbound one is
    // still one Carol was verified against and can reach directly.
    await expect(observe(impl)).rejects.toThrow(/not permitted to see/);
    expect(removals).toEqual([]);
  }));

  it("a collaborator who lost access is torn down entirely",
      () => withImpl(null, async (impl, removals) => {
    // Unchanged behaviour: no scope to be in or out of, so the record goes and every gatekeeper
    // forgets her.
    await observe(impl);

    expect(removals).toEqual([`${GATEKEEPER_ID}:${OBSERVER_ID}`]);
    expect(impl.storage.observers.get(CAROL)).toBeUndefined();
  }));

  it("every out-of-scope observer is de-registered, together",
      () => withImpl("use", async (impl, removals) => {
    // A second "use" collaborator, Dave, also registered on the unbound connection. Both are out
    // of scope, so the observation is allowed and both removals go out; neither record is touched.
    impl.storage.observers.put(
        { profileId: "dave", observerId: "obs-dave", accountChoices: { [GATEKEEPER_ID]: 11 } });
    impl.getSharingManager = async () => ({
      getEffectiveRole: (profileId: string) =>
          profileId === CAROL || profileId === "dave" ? "use" : null,
      hasAnyShares: () => true,
    });

    await impl.authorizeObservation(
        GATEKEEPER_ID, { ...DESCRIPTION, excludeObservers: [OBSERVER_ID, "obs-dave"] }, CALLER);

    expect(removals.toSorted()).toEqual([`${GATEKEEPER_ID}:${OBSERVER_ID}`, `${GATEKEEPER_ID}:obs-dave`]);
    expect(impl.storage.observers.byObserverId.get(OBSERVER_ID)).toBeDefined();
    expect(impl.storage.observers.byObserverId.get("obs-dave")).toBeDefined();
  }));

  it("an unknown observer id is ignored", () => withImpl("use", async (impl, removals) => {
    bindIntoGadget(impl);

    // Nothing resolves the id, so there is no observer to block for -- and, in particular, an id
    // the gatekeeper remembers past a teardown must not wedge the connection permanently.
    await impl.authorizeObservation(
        GATEKEEPER_ID, { ...DESCRIPTION, excludeObservers: ["obs-nobody"] }, CALLER);

    expect(removals).toEqual([]);
  }));

  it("a concurrent registration waits for the in-flight de-registration it raced",
      () => withImpl("use", async (impl, removals) => {
    // The exclusion teardown's removeObserver parks in flight; a bind plus a fresh open then race
    // it with an addObserver for the same (observer, gatekeeper) pair. The overseer is the only
    // caller of either, so serializing its own calls per pair is what keeps the add from being
    // silently undone by the older removal: it runs only after the removal completes, and
    // re-registers cleanly. The observation itself was classified before the teardown began and
    // is admitted; the bind landing mid-teardown is inside the window the design tolerates.
    let events: string[] = [];
    let releaseRemove!: () => void;
    let removeReached = new Promise<void>(resolve => {
      impl.getGatekeeperFacet = (id: number) => ({
        removeObserver: async (observerId: string) => {
          events.push("remove:start");
          resolve();
          await new Promise<void>(release => { releaseRemove = release; });
          removals.push(`${id}:${observerId}`);
          events.push("remove:end");
        },
        addObserver: async () => { events.push("add"); },
      });
    });

    // The connection is unbound, so the observation proceeds by de-registering Carol -- parked.
    let observation = observe(impl);
    await removeReached;

    // Rebind and re-open: the fresh open's registration must queue behind the parked removal.
    bindIntoGadget(impl);
    let open = impl.ensureObserver(
        CAROL, { getVerifier: async () => ({}), describeConnectedAccount: async () => null },
        "use");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(events).toEqual(["remove:start"]);

    releaseRemove();
    await observation;
    await open;
    expect(events).toEqual(["remove:start", "remove:end", "add"]);
  }));
});

// An enabled hook is a live write channel into a gadget a "use" collaborator can open, so its
// connection stays in their verification scope even with no binding edge -- both for exclusion
// (above) and for what a fresh open verifies them against.
describe("hooks keep an unbound connection in use scope", () => {
  function armHook(impl: any, enabled: boolean): void {
    impl.storage.boundHooks.put({
      id: 5,
      actionId: 999,
      gatekeeperId: GATEKEEPER_ID,
      vendorId: "testvendor",
      controller: {} as any,
      callback: {} as any,
      description: { title: "Hook", description: "Delivers events" },
      enabled,
    });
  }

  it("an enabled hook blocks an excluded observation from an unbound connection",
      () => withImpl("use", async (impl, removals) => {
    armHook(impl, true);

    // The hook keeps writing the connection's data into a gadget Carol can open, so she can still
    // reach what it produces: the observation must block, exactly as if a gadget bound it.
    await expect(observe(impl)).rejects.toThrow(/not permitted to see/);
    expect(removals).toEqual([]);
  }));

  it("a disabled hook leaves the unbound connection out of scope",
      () => withImpl("use", async (impl, removals) => {
    armHook(impl, false);

    // A disabled hook delivers nothing (startHook re-checks `enabled`), so nothing reaches Carol
    // and she is de-registered as usual.
    await observe(impl);
    expect(removals).toEqual([`${GATEKEEPER_ID}:${OBSERVER_ID}`]);
  }));

  it("a fresh use open is verified against a hook-armed unbound connection",
      () => withImpl("use", async (impl) => {
    armHook(impl, true);
    let added: string[] = [];
    impl.getGatekeeperFacet = (id: number) => ({
      addObserver: async (observerId: string) => { added.push(`${id}:${observerId}`); },
      removeObserver: async () => {},
    });

    await impl.ensureObserver(
        CAROL, { getVerifier: async () => ({}), describeConnectedAccount: async () => null },
        "use");

    expect(added).toEqual([`${GATEKEEPER_ID}:${OBSERVER_ID}`]);
  }));
});

// A bound agent spawner's env hands the connections it names to any agent a "use" collaborator
// spawns through the gadget (connectToGadget -> spawn/spawnCallable seeds the chat from
// config.env), so those connections stay in their verification scope even with no direct binding
// edge -- both for exclusion and for what a fresh open verifies them against.
describe("a bound agent spawner's env keeps its targets in use scope", () => {
  function bindSpawnerIntoGadget(impl: any): void {
    impl.storage.gatekeepers.put({
      id: 200,
      resourceTitle: "Spawner",
      class: {} as any,
      creationSpec: {
        type: "agentSpawner",
        config: { displayName: "S", modelId: null, env: { DB: GATEKEEPER_ID } },
      },
    });
    impl.storage.gadgets.put(
        { type: "gadget", id: 100, title: "G", created: new Date(0), bindingName: "G", bindings: {} });
    impl.bindWorkpiece(100, "SPAWN", 200);
  }

  it("a use observer blocks an observation from a connection reachable only through the env",
      () => withImpl("use", async (impl, removals) => {
    bindSpawnerIntoGadget(impl);

    // No gadget binds the connection itself, but an agent spawned through the bound spawner reads
    // it with the creator's authority and returns its data into state Carol can open: the
    // observation must block, exactly as if a gadget bound it directly.
    await expect(observe(impl)).rejects.toThrow(/not permitted to see/);
    expect(removals).toEqual([]);
  }));

  it("a fresh use open is verified against the env's connection",
      () => withImpl("use", async (impl) => {
    bindSpawnerIntoGadget(impl);
    let added: string[] = [];
    impl.getGatekeeperFacet = (id: number) => ({
      addObserver: async (observerId: string) => { added.push(`${id}:${observerId}`); },
      removeObserver: async () => {},
    });

    await impl.ensureObserver(
        CAROL, { getVerifier: async () => ({}), describeConnectedAccount: async () => null },
        "use");

    // Only the env's connection needs verification -- the spawner itself is vendorless.
    expect(added).toEqual([`${GATEKEEPER_ID}:${OBSERVER_ID}`]);
  }));
});
