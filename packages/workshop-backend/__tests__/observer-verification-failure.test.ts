// What ensureObserver does with a binding it could not verify: every failure is collected and
// reported as a denial the user can act on, and no registration another admission may share is
// torn down.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// git-migration-do.test.ts); the gatekeeper facet and the client's User DO are the only fakes.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { GatekeeperRecord } from "../src/storage-schema/overseer-storage.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type ObserverImpl = OverseerDurableObject["impl"];
type ObserverClientUser = Parameters<ObserverImpl["ensureObserver"]>[1];
type ObserverConfigureCallback = NonNullable<Parameters<ObserverImpl["ensureObserver"]>[3]>;

// Tests replace the facet factory, so the stored class is never instantiated.
const fakeGatekeeperClass = {} as unknown as GatekeeperRecord["class"];

// Seed the owner profile id, so the sharing manager needs no User DO round trip.
function seedOwner(impl: ObserverImpl): void {
  impl.ownerProfileId = "owner";
}

function seedGatekeepers(impl: ObserverImpl, ids: number[] = [1, 2]): void {
  for (let id of ids) {
    impl.storage.gatekeepers.put({
      id,
      resourceTitle: `Connection ${id}`,
      class: fakeGatekeeperClass,
      creationSpec: {
        type: "gatekeeper",
        vendorId: "testvendor",
        resourceUrl: `https://example.com/${id}`,
        typeUrlPattern: "https://*",
      },
    });
  }
}

// Facets for every seeded connection, each registering observers through `hooks`.
function setObserverFacets(impl: ObserverImpl, hooks: {
  addObserver?(id: number, observerId: string): Promise<void>;
  removeObserver?(id: number, observerId: string): Promise<void>;
} = {}): void {
  const getFacet = async (id: number) => ({
    addObserver: async (observerId: string) => { await hooks.addObserver?.(id, observerId); },
    removeObserver: async (observerId: string) => { await hooks.removeObserver?.(id, observerId); },
  });
  // These direct-DO tests exercise only the observer methods admission calls, not the full RPC
  // facet.
  impl.getGatekeeperFacet = getFacet as unknown as ObserverImpl["getGatekeeperFacet"];
}

// Direct-DO test doubles supply only the RPC methods admission exercises.
const configureAll = {
  configure: async (needs: {gatekeeperId: number}[]) =>
      needs.map(need => ({ gatekeeperId: need.gatekeeperId, accountId: need.gatekeeperId * 10 })),
} as unknown as ObserverConfigureCallback;

// A client User DO that always has the account and always mints a verifier.
const fakeClientUser = {
  getVerifier: async () => ({}),
  describeConnectedAccount: async () => null,
} as unknown as ObserverClientUser;

describe("a binding that fails verification", () => {
  it("reports a verifier rejection as a denial, not as the raw RPC error", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-verify-getverifier");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      seedOwner(impl);
      seedGatekeepers(impl);
      // Already-configured coverage for both gatekeepers, as a previous successful open left it.
      impl.storage.observers.put(
          { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10, 2: 20 } });

      let removed: number[] = [];
      setObserverFacets(impl, { removeObserver: async id => { removed.push(id); } });

      // Gatekeeper 1's verifier never materializes: the client's User DO *rejects* (the
      // deterministic vendor-mismatch throw, or any cross-worker transport failure) rather than
      // returning null.
      let failingClientUser = {
        getVerifier: async (accountId: number) => {
          if (accountId === 10) throw new Error("account is for a different vendor");
          return {};
        },
        describeConnectedAccount: async () => null,
      } as unknown as ObserverClientUser;

      // The rejection is caught per binding like any other refusal, so with no repair channel the
      // open is denied with the descriptive message that names what to fix -- rather than the
      // transport error escaping mid-Promise.all.
      await expect(impl.ensureObserver("alice", failingClientUser, "workspace"))
          .rejects.toThrow(/could not confirm/);

      // Her registrations are what make gatekeepers name her in `excludeObservers`, so dropping
      // one would be fail-open.
      expect(removed).toEqual([]);

      // Neither producer's restricted reads are blocked, though -- both are verifiable, so
      // admission is the whole enforcement and nobody unverified can be watching.
      let restricted = { title: "t", description: "d", containsRestrictedData: true };
      await expect(impl.authorizeObservation(1, restricted, { from: "user" }))
          .resolves.toBeUndefined();
      await expect(impl.authorizeObservation(2, restricted, { from: "user" }))
          .resolves.toBeUndefined();
    });
  });

  it("keeps all of a returning observer's registrations, including ones this call added",
      async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-verify-keeps-registration");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      seedOwner(impl);
      seedGatekeepers(impl);
      // Alice's previous open covered gatekeeper 1 only; gatekeeper 2 is a binding added since,
      // which she has never been verified against.
      impl.storage.observers.put(
          { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10 } });

      let removed: number[] = [];
      setObserverFacets(impl, {
        // The connection Alice was already admitted for has now revoked her access upstream.
        addObserver: async id => { if (id === 1) throw new Error("access revoked upstream"); },
        removeObserver: async id => { removed.push(id); },
      });

      await expect(impl.ensureObserver("alice", fakeClientUser, "workspace", configureAll))
          .rejects.toThrow(/could not confirm/);

      // Gatekeeper 1's registration predates this call and survives, so it keeps naming her in
      // `excludeObservers`. Gatekeeper 2's was created by this call -- but her persisted
      // observerId is shared with any concurrent open, which may have registered (and persisted)
      // the very same gatekeeper, so it is kept too: de-registering is the fail-open direction,
      // a spurious registration only blocks fail-closed until a later open re-verifies it.
      expect(removed).toEqual([]);
    });
  });

  it.each(["returning", "first-time"])(
      "a failed open does not roll back registrations a concurrent open published (%s observer)",
      async kind => {
    let stub = env.TEST_OVERSEER.getByName(`observer-verify-concurrent-${kind}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      seedOwner(impl);
      seedGatekeepers(impl, [1, 2, 3]);
      // A returning Alice's record predates connections 2 and 3; a first-time Alice has none. Both
      // opens must register her with both under one observerId they share.
      if (kind === "returning") {
        impl.storage.observers.put(
            { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10 } });
      }

      let removed: number[] = [];
      let registered = new Set<string>();
      // Call A parks on connection 3's *verifier* -- deliberately outside the per-(observer,
      // gatekeeper) serialization of the addObserver RPCs themselves, which would otherwise queue
      // call B's registration behind a parked one. Connection 3 then admits only call B's
      // registration (the 1st): call A's attempts (the 2nd, and the 3rd after its repair
      // re-prompt) are refused.
      let releaseVerifier!: () => void;
      let verifierParked = new Promise<void>(resolve => { releaseVerifier = resolve; });
      let reached!: () => void;
      let verifierReached = new Promise<void>(resolve => { reached = resolve; });
      let gk3Verifiers = 0;
      // A local stand-in for the client's User DO, supplying only the methods admission calls.
      let parkingClientUser = {
        getVerifier: async (accountId: number) => {
          if (accountId === 30 && ++gk3Verifiers === 1) { reached(); await verifierParked; }
          return {};
        },
        describeConnectedAccount: async () => null,
      } as unknown as ObserverClientUser;
      let gk3Adds = 0;
      setObserverFacets(impl, {
        addObserver: async (id, observerId) => {
          registered.add(observerId);
          if (id === 3 && ++gk3Adds > 1) throw new Error("no access");
        },
        removeObserver: async id => { removed.push(id); },
      });

      // Call A registers her with connection 2, then parks before registering with connection 3.
      let callA = impl.ensureObserver("alice", parkingClientUser, "workspace", configureAll);
      callA.catch(() => {});  // asserted below; not unhandled in the meantime
      await verifierReached;

      // Call B -- the same observer opening concurrently -- verifies everything and publishes the
      // choices asserting all three registrations.
      await impl.ensureObserver("alice", fakeClientUser, "workspace", configureAll);
      expect(impl.storage.observers.get("alice")?.accountChoices).toEqual({ 1: 10, 2: 20, 3: 30 });

      // Now connection 3 refuses call A terminally.
      releaseVerifier();
      await expect(callA).rejects.toThrow(/could not confirm/);

      // Call A also registered her with connection 2 before failing on 3, but must not roll that
      // back: the registration is keyed by the shared observerId, so removing it would delete the
      // one call B just made -- while B's published choices assert it exists, breaking every
      // future exclusion that names her.
      expect(removed).toEqual([]);
      let record = impl.storage.observers.get("alice");
      expect(record?.accountChoices).toEqual({ 1: 10, 2: 20, 3: 30 });
      expect(registered).toEqual(new Set([record?.observerId]));
    });
  });

  it.each([
    { mode: "deleted", outcome: "verifies" },
    { mode: "replaced", outcome: "verifies" },
    { mode: "deleted", outcome: "fails" },
    { mode: "replaced", outcome: "fails" },
  ])("de-registers the id of an admission that $outcome after its record was $mode",
      async ({ mode, outcome }) => {
    let stub = env.TEST_OVERSEER.getByName(`observer-verify-stale-${mode}-${outcome}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      seedOwner(impl);
      seedGatekeepers(impl);
      let registrations = new Set<string>();
      setObserverFacets(impl, {
        addObserver: async (id, observerId) => {
          // A failing admission is refused by connection 2 after connection 1 registered her.
          if (outcome === "fails" && id === 2) throw new Error("no access");
          registrations.add(`${id}:${observerId}`);
        },
        removeObserver: async (id, observerId) => { registrations.delete(`${id}:${observerId}`); },
      });

      // Alice loses access while her first admission waits on its account prompt: the teardown
      // deletes her record before the admission registers anything ("replaced": and a later
      // admission has since reserved a new one).
      let release!: () => void;
      let parked = new Promise<void>(resolve => { release = resolve; });
      let prompted!: () => void;
      let promptOpen = new Promise<void>(resolve => { prompted = resolve; });
      let admission = impl.ensureObserver("alice", fakeClientUser, "workspace", {
        configure: async (needs: {gatekeeperId: number}[]) => {
          prompted();
          await parked;
          return needs.map(need => ({ gatekeeperId: need.gatekeeperId, accountId: 10 }));
        },
      } as unknown as ObserverConfigureCallback);
      await promptOpen;
      impl.storage.observers.delete("alice");
      let replacement = { profileId: "alice", observerId: "obs-new", accountChoices: { 1: 99 } };
      if (mode === "replaced") impl.storage.observers.put(replacement);
      release();

      await expect(admission).rejects.toThrow(
          outcome === "fails" ? /could not confirm/ : /access to this workspace changed/);
      expect(impl.storage.observers.get("alice"))
          .toEqual(mode === "replaced" ? replacement : undefined);
      expect(registrations).toEqual(new Set());
    });
  });
});
