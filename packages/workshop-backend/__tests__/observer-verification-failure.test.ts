// What ensureObserver does with a binding it could not verify: every failure is collected and
// reported as a denial the user can act on, and nothing the call did not create is torn down.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// git-migration-do.test.ts); the gatekeeper facet and the client's User DO are the only fakes.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// Seed the owner profile id, so the sharing manager needs no User DO round trip.
function seedOwner(impl: any): void {
  impl.ownerProfileId = "owner";
}

function seedGatekeepers(impl: any, ids: number[] = [1, 2]): void {
  for (let id of ids) {
    impl.storage.gatekeepers.put({
      id,
      resourceTitle: `Connection ${id}`,
      class: {} as any,
      creationSpec: {
        type: "gatekeeper",
        vendorId: "testvendor",
        resourceUrl: `https://example.com/${id}`,
        typeUrlPattern: "https://*",
      },
    });
  }
}

// A client User DO that always has the account and always mints a verifier.
const fakeClientUser = {
  getVerifier: async () => ({}),
  describeConnectedAccount: async () => null,
} as any;

describe("a binding that fails verification", () => {
  it("reports a verifier rejection as a denial, not as the raw RPC error", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-verify-getverifier");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      seedOwner(impl);
      seedGatekeepers(impl);
      // Already-configured coverage for both gatekeepers, as a previous successful open left it.
      impl.storage.observers.put(
          { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10, 2: 20 } });

      let removed: number[] = [];
      impl.getGatekeeperFacet = (id: number) => ({
        addObserver: async () => {},
        removeObserver: async () => { removed.push(id); },
      });

      // Gatekeeper 1's verifier never materializes: the client's User DO *rejects* (the
      // deterministic vendor-mismatch throw, or any cross-worker transport failure) rather than
      // returning null.
      let failingClientUser = {
        getVerifier: async (accountId: number) => {
          if (accountId === 10) throw new Error("account is for a different vendor");
          return {};
        },
        describeConnectedAccount: async () => null,
      } as any;

      // The rejection is caught per binding like any other refusal, so with no repair channel the
      // open is denied with the descriptive message that names what to fix -- rather than the
      // transport error escaping mid-Promise.all.
      await expect(impl.ensureObserver("alice", failingClientUser, "build"))
          .rejects.toThrow(/could not confirm/);

      // Alice was already an admitted observer, so this call registered nothing and there is
      // nothing for the rollback to remove. Her registrations are what make gatekeepers name her
      // in `excludeObservers`, so dropping one would be fail-open.
      expect(removed).toEqual([]);
    });
  });

  it("keeps all of a returning observer's registrations, including ones this call added",
      async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-verify-keeps-registration");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      seedOwner(impl);
      seedGatekeepers(impl);
      // Alice's previous open covered gatekeeper 1 only; gatekeeper 2 is a binding added since,
      // which she has never been verified against.
      impl.storage.observers.put(
          { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10 } });

      let removed: number[] = [];
      impl.getGatekeeperFacet = (id: number) => ({
        // Gatekeeper 1 has revoked her access upstream: the binding she *was* admitted for is the
        // one that now refuses, which is exactly the case that used to drop her registration.
        addObserver: async () => { if (id === 1) throw new Error("access revoked upstream"); },
        removeObserver: async () => { removed.push(id); },
      });

      let configureCb = { configure: async (needs: {gatekeeperId: number}[]) =>
          needs.map(need => ({ gatekeeperId: need.gatekeeperId, accountId: 20 })) } as any;

      await expect(impl.ensureObserver("alice", fakeClientUser, "build", configureCb))
          .rejects.toThrow(/could not confirm/);

      // Gatekeeper 1's registration predates this call and survives, so it keeps naming her in
      // `excludeObservers`. Gatekeeper 2's was created by this call -- but her persisted
      // observerId is shared with any concurrent open, which may have registered (and persisted)
      // the very same gatekeeper, so it is kept too: de-registering is the fail-open direction,
      // a spurious registration only blocks fail-closed until a later open re-verifies it.
      expect(removed).toEqual([]);
    });
  });

  it("a failed open does not roll back registrations a concurrent open persisted", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-verify-concurrent");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      seedOwner(impl);
      seedGatekeepers(impl, [1, 2, 3]);
      // Alice's record predates connections 2 and 3, so both opens must register her with both --
      // under the one persisted observerId they share.
      impl.storage.observers.put(
          { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10 } });

      let removed: number[] = [];
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
      let parkingClientUser = {
        getVerifier: async (accountId: number) => {
          if (accountId === 30 && ++gk3Verifiers === 1) { reached(); await verifierParked; }
          return {};
        },
        describeConnectedAccount: async () => null,
      } as any;
      let gk3Adds = 0;
      impl.getGatekeeperFacet = (id: number) => ({
        addObserver: async () => {
          if (id === 3 && ++gk3Adds > 1) throw new Error("no access");
        },
        removeObserver: async () => { removed.push(id); },
      });
      let configureCb = { configure: async (needs: {gatekeeperId: number}[]) =>
          needs.map(need => ({ gatekeeperId: need.gatekeeperId, accountId: need.gatekeeperId * 10 }))
      } as any;

      // Call A registers her with connection 2, then parks before registering with connection 3.
      let callA = impl.ensureObserver("alice", parkingClientUser, "build", configureCb);
      callA.catch(() => {});  // asserted below; not unhandled in the meantime
      await verifierReached;

      // Call B -- the same returning observer opening concurrently -- verifies everything and
      // persists the record asserting all three registrations.
      await impl.ensureObserver("alice", fakeClientUser, "build", configureCb);
      expect(impl.storage.observers.get("alice").accountChoices).toEqual({ 1: 10, 2: 20, 3: 30 });

      // Now connection 3 refuses call A terminally.
      releaseVerifier();
      await expect(callA).rejects.toThrow(/could not confirm/);

      // Call A also registered her with connection 2 before failing on 3, but must not roll that
      // back: the registration is keyed by the shared observerId, so removing it would delete the
      // one call B just made -- while B's persisted record asserts it exists, breaking every
      // future exclusion that names her.
      expect(removed).toEqual([]);
      expect(impl.storage.observers.get("alice").accountChoices).toEqual({ 1: 10, 2: 20, 3: 30 });
    });
  });

  it("a first-ever verification failure still rolls its registrations back", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-verify-first-ever");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      seedOwner(impl);
      seedGatekeepers(impl);
      // No observer record: Alice has never been admitted, so the observerId minted for this call
      // is discarded with the unpersisted record and anything registered under it would linger
      // unresolvable.
      let removed: number[] = [];
      impl.getGatekeeperFacet = (id: number) => ({
        addObserver: async () => { if (id === 2) throw new Error("no access"); },
        removeObserver: async () => { removed.push(id); },
      });

      let configureCb = { configure: async (needs: {gatekeeperId: number}[]) =>
          needs.map(need => ({ gatekeeperId: need.gatekeeperId, accountId: need.gatekeeperId * 10 }))
      } as any;

      await expect(impl.ensureObserver("alice", fakeClientUser, "build", configureCb))
          .rejects.toThrow(/could not confirm/);

      // Both the one that verified and the one that refused are rolled back, and no record is
      // persisted.
      expect(removed.toSorted()).toEqual([1, 2]);
      expect(impl.storage.observers.get("alice")).toBeUndefined();
    });
  });
});
