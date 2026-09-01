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
      { id: 100, title: "G", created: new Date(0), bindingName: "G", bindings: {} });
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

  it("an observer put back in scope mid-teardown blocks instead of being de-registered",
      () => withImpl("use", async (impl, removals) => {
    // A second "use" collaborator, Dave, named after Carol.
    impl.storage.observers.put(
        { profileId: "dave", observerId: "obs-dave", accountChoices: { [GATEKEEPER_ID]: 11 } });
    impl.getSharingManager = async () => ({
      getEffectiveRole: (profileId: string) =>
          profileId === CAROL || profileId === "dave" ? "use" : null,
      hasAnyShares: () => true,
    });
    // Both start out of scope (nothing binds the connection), so both are due to be de-registered
    // -- but each removal awaits, and during Carol's the owner binds the connection into a gadget,
    // putting it back into everyone's "use" scope. Dave can now reach the observation, and his
    // registration may be freshly re-asserted by an open racing this teardown, so his stale
    // removal must not be issued: he is re-classified adjacent to it and blocks instead.
    impl.getGatekeeperFacet = (id: number) => ({
      removeObserver: async (observerId: string) => {
        if (observerId === OBSERVER_ID) bindIntoGadget(impl);
        removals.push(`${id}:${observerId}`);
      },
    });

    await expect(impl.authorizeObservation(
        GATEKEEPER_ID, { ...DESCRIPTION, excludeObservers: [OBSERVER_ID, "obs-dave"] }, CALLER))
        .rejects.toThrow(/not permitted to see/);

    // Carol's removal was already in flight; Dave's never happened and his record is intact.
    expect(removals).toEqual([`${GATEKEEPER_ID}:${OBSERVER_ID}`]);
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
});
