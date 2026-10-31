// Forward exclusion (`ObservationDescription.excludeObservers`) blocks an observation when a named
// observer could see it. A "use" collaborator's forward reach is what the gadgets their access
// includes reach. Historical producers may still require admission for retained data, but do not
// deliver new observations; their registrations must not block reads the collaborator cannot reach.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// observer-scope-restart.test.ts).

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { CollaboratorAccess } from "@gadgets/workshop-shared/api";
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

// Carol's access: every gadget she is granted, as a "use" collaborator.
const GADGET_100: CollaboratorAccess = { role: "use", gadgetIds: [100] };

// The slice of SharingManager the exclusion path reads.
type FakeSharing = {
  getEffectiveAccess(profileId: string): CollaboratorAccess | undefined;
};

function fakeSharing(access: Record<string, CollaboratorAccess>): FakeSharing {
  return {getEffectiveAccess: (profileId: string) => access[profileId]};
}

async function withImpl(
    access: CollaboratorAccess | null,
    fn: (impl: any, removals: Removals) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`observer-exclude-scope-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerProfileId = OWNER;
    // Carol's access in the permission graph. Stubbed rather than seeded through the sharing table
    // so the "lost access entirely" case needs no revocation plumbing.
    let sharing = fakeSharing(access ? { [CAROL]: access } : {});
    impl.getSharingManager = async () => sharing;

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

// The slice of OverseerImpl the seeding helpers below drive.
type SeedTarget = {
  storage: { gadgets: { put(record: object): void } };
  bindWorkpiece(gadgetId: number, name: string, target: number): void;
};

// A gadget, holding a permanent edge onto the connection when `bind`, which is what puts it in the
// scope of anyone holding that gadget.
function seedGadget(impl: SeedTarget, id: number, bind = false): void {
  impl.storage.gadgets.put(
      { type: "gadget", id, title: `G${id}`, created: new Date(0), bindingName: `G${id}`, bindings: {} });
  if (bind) impl.bindWorkpiece(id, "DB", GATEKEEPER_ID);
}

function bindIntoGadget(impl: SeedTarget): void {
  seedGadget(impl, 100, true);
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

describe("excludeObservers against the observer's forward reach", () => {
  it("a use collaborator blocks an observation from a connection her gadget binds",
      () => withImpl(GADGET_100, async (impl, removals) => {
    bindIntoGadget(impl);

    await expect(observe(impl)).rejects.toThrow(/not permitted to see/);

    // A blocked observation leaves no teardown behind it.
    expect(removals).toEqual([]);
    expect(impl.storage.observers.get(CAROL)).toBeDefined();
  }));

  it("a use collaborator whose gadgets don't reach the connection is de-registered",
      () => withImpl({ role: "use", gadgetIds: [101] }, async (impl, removals) => {
    // Another gadget binds the connection, but hers does not: a legacy connection's exclusion
    // spans the connection, yet she holds nothing that reads it, so her stale registration must
    // not block the read. She keeps her record (she is still a collaborator).
    bindIntoGadget(impl);
    seedGadget(impl, 101);

    await observe(impl);

    expect(removals).toEqual([`${GATEKEEPER_ID}:${OBSERVER_ID}`]);
    expect(impl.storage.observers.get(CAROL)).toBeDefined();
  }));

  it("a legacy all-gadget use collaborator blocks once any gadget binds the connection",
      () => withImpl({ role: "use", gadgetIds: "all" }, async (impl, removals) => {
    seedGadget(impl, 101);
    seedGadget(impl, 102, true);

    await expect(observe(impl)).rejects.toThrow(/not permitted to see/);
    expect(removals).toEqual([]);
  }));

  it("a build collaborator blocks even when no gadget binds the connection",
      () => withImpl({ role: "build" }, async (impl, removals) => {
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

  it("an unknown observer id is ignored", () => withImpl(GADGET_100, async (impl, removals) => {
    bindIntoGadget(impl);

    // Nothing resolves the id, so there is no observer to block for -- and, in particular, an id
    // the gatekeeper remembers past a teardown must not wedge the connection permanently.
    await impl.authorizeObservation(
        GATEKEEPER_ID, { ...DESCRIPTION, excludeObservers: ["obs-nobody"] }, CALLER);

    expect(removals).toEqual([]);
  }));

  it("every out-of-scope observer is de-registered, together",
      () => withImpl(GADGET_100, async (impl, removals) => {
    // A second "use" collaborator, Dave, also registered on the unbound connection. Both are out
    // of scope, so the observation is allowed and both removals go out; neither record is touched.
    seedGadget(impl, 100);
    impl.storage.observers.put(
        { profileId: "dave", observerId: "obs-dave", accountChoices: { [GATEKEEPER_ID]: 11 } });
    let sharing = fakeSharing({ [CAROL]: GADGET_100, dave: { role: "use", gadgetIds: "all" } });
    impl.getSharingManager = async () => sharing;

    await impl.authorizeObservation(
        GATEKEEPER_ID, { ...DESCRIPTION, excludeObservers: [OBSERVER_ID, "obs-dave"] }, CALLER);

    expect(removals.toSorted()).toEqual([`${GATEKEEPER_ID}:${OBSERVER_ID}`, `${GATEKEEPER_ID}:obs-dave`]);
    expect(impl.storage.observers.byObserverId.get(OBSERVER_ID)).toBeDefined();
    expect(impl.storage.observers.byObserverId.get("obs-dave")).toBeDefined();
  }));

  it("a concurrent registration waits for the in-flight de-registration it raced",
      () => withImpl(GADGET_100, async (impl, removals) => {
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

    // Rebind and re-open her gadget: the fresh open's registration must queue behind the parked
    // removal.
    bindIntoGadget(impl);
    let open = impl.ensureObserver(
        CAROL, { getVerifier: async () => ({}), describeConnectedAccount: async () => null },
        { gadgetId: 100 });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(events).toEqual(["remove:start"]);

    releaseRemove();
    await observation;
    await open;
    expect(events).toEqual(["remove:start", "remove:end", "add"]);
  }));
});

// An enabled hook is a live write channel into the gadget it wakes, so its connection stays in the
// verification scope of whoever holds that gadget even with no binding edge. The gadget is the one
// recorded with the hook (which its firings are attributed to), or every gadget when none is.
describe("hooks keep an unbound connection in the scope of the gadget they wake", () => {
  function armHook(impl: any, enabled: boolean, gadgetId?: number): void {
    impl.storage.boundHooks.put({
      id: 5,
      actionId: 999,
      gatekeeperId: GATEKEEPER_ID,
      vendorId: "testvendor",
      ...(gadgetId !== undefined ? { gadgetId } : {}),
      controller: {} as any,
      callback: {} as any,
      description: { title: "Hook", description: "Delivers events" },
      enabled,
    });
  }

  it("an enabled hook into her gadget blocks an excluded observation from an unbound connection",
      () => withImpl(GADGET_100, async (impl, removals) => {
    seedGadget(impl, 100);
    armHook(impl, true, 100);

    // The hook keeps writing the connection's data into a gadget Carol can open, so she can still
    // reach what it produces: the observation must block, exactly as if a gadget bound it.
    await expect(observe(impl)).rejects.toThrow(/not permitted to see/);
    expect(removals).toEqual([]);
  }));

  it("an enabled hook recorded for another gadget leaves the connection out of her scope",
      () => withImpl(GADGET_100, async (impl, removals) => {
    seedGadget(impl, 100);
    seedGadget(impl, 101);
    armHook(impl, true, 101);

    // The hook writes into gadget 101, which Carol does not hold, so she can't reach what it
    // produces and is de-registered as usual.
    await observe(impl);
    expect(removals).toEqual([`${GATEKEEPER_ID}:${OBSERVER_ID}`]);
  }));

  it("an enabled hook whose gadget is unresolvable reaches every gadget, fail-closed",
      () => withImpl(GADGET_100, async (impl, removals) => {
    // No gadgetId and no default gadget: nothing says which gadget it wakes, so it must count as
    // waking hers.
    seedGadget(impl, 100);
    armHook(impl, true);

    await expect(observe(impl)).rejects.toThrow(/not permitted to see/);
    expect(removals).toEqual([]);
  }));

  it("a disabled hook leaves the unbound connection out of scope",
      () => withImpl(GADGET_100, async (impl, removals) => {
    seedGadget(impl, 100);
    armHook(impl, false, 100);

    // A disabled hook delivers nothing (startHook re-checks `enabled`), so nothing reaches Carol
    // and she is de-registered as usual.
    await observe(impl);
    expect(removals).toEqual([`${GATEKEEPER_ID}:${OBSERVER_ID}`]);
  }));
});

// A bound agent spawner's bindings hand the connections they name to any agent a "use"
// collaborator spawns through the gadget (connectToGadget -> spawn/spawnCallable seeds the chat
// from them), so those connections stay in the verification scope of whoever holds the gadget even
// with no direct binding edge -- both for exclusion and for what a fresh open verifies them
// against.
describe("a bound agent spawner's env keeps its targets in the gadget's scope", () => {
  function bindSpawnerIntoGadget(impl: any, spawnerTarget = GATEKEEPER_ID): void {
    impl.storage.gatekeepers.put({
      id: 200,
      resourceTitle: "Spawner",
      class: {} as any,
      creationSpec: { type: "agentSpawner", config: { displayName: "S", modelId: null } },
      bindings: { DB: { target: spawnerTarget } },
    });
    seedGadget(impl, 100);
    impl.bindWorkpiece(100, "SPAWN", 200);
  }

  it("a use observer blocks an observation from a connection reachable only through the env",
      () => withImpl(GADGET_100, async (impl, removals) => {
    bindSpawnerIntoGadget(impl);

    // No gadget binds the connection itself, but an agent spawned through the bound spawner reads
    // it with the creator's authority and returns its data into state Carol can open: the
    // observation must block, exactly as if a gadget bound it directly.
    await expect(observe(impl)).rejects.toThrow(/not permitted to see/);
    expect(removals).toEqual([]);
  }));

  it("a use observer blocks an observation from a gadget the env binds",
      () => withImpl(GADGET_100, async (impl, removals) => {
    // The spawner binds gadget 101, which binds the connection: the spawned agent can drive 101,
    // so what 101 reaches is in 100's reach too.
    seedGadget(impl, 101, true);
    bindSpawnerIntoGadget(impl, 101);

    await expect(observe(impl)).rejects.toThrow(/not permitted to see/);
    expect(removals).toEqual([]);
  }));

  it("a fresh gadget open is verified against the env's connection",
      () => withImpl(GADGET_100, async (impl) => {
    bindSpawnerIntoGadget(impl);
    let added: string[] = [];
    impl.getGatekeeperFacet = (id: number) => ({
      addObserver: async (observerId: string) => { added.push(`${id}:${observerId}`); },
      removeObserver: async () => {},
    });

    await impl.ensureObserver(
        CAROL, { getVerifier: async () => ({}), describeConnectedAccount: async () => null },
        { gadgetId: 100 });

    // Only the env's connection needs verification -- the spawner itself is vendorless.
    expect(added).toEqual([`${GATEKEEPER_ID}:${OBSERVER_ID}`]);
  }));
});
