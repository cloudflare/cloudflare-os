// A failed live check (a gatekeeper's addObserver refusing, or the verifier failing to resolve)
// must scrub that gatekeeper from the collaborator's *persisted* observer record synchronously
// with the failure determination: the record is the standing claim that this collaborator was
// verified for that producer, and this open is not going to renew it. Because the claim is what
// admitted them, the shrink also severs their still-live sessions (see observer-scope-restart).
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// git-migration-do.test.ts); the gatekeeper facet, the client's User DO, and the restart are the
// only fakes -- a real ctx.abort() would kill the test DO.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// Seed the owner profile id (so the sharing manager needs no User DO round trip) and record the
// restart a coverage shrink schedules instead of performing it.
function recordRestarts(impl: any): string[] {
  impl.ownerProfileId = "owner";
  let restarts: string[] = [];
  impl.scheduleAccessRestart = async (reason: string) => { restarts.push(reason); };
  return restarts;
}

function seedGatekeepers(impl: any): void {
  for (let id of [1, 2]) {
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

describe("observer coverage scrub on a failed live check", () => {
  it("a refused re-verification drops the entry and severs the collaborator's sessions",
      async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-coverage-scrub-refused");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      seedGatekeepers(impl);
      let restarts = recordRestarts(impl);
      // Alice is a reachable collaborator whose previous successful open left coverage for both
      // gatekeepers.
      impl.storage.collaborators.put({
        profile: { type: "user", id: "alice", name: "Alice" },
        addedBy: [{ type: "user", sharer: "owner", created: new Date(), role: "build" }],
      });
      impl.storage.observers.put(
          { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10, 2: 20 } });

      impl.getGatekeeperFacet = (id: number) => ({
        addObserver: async () => {
          if (id === 1) throw new Error("access revoked upstream");
        },
        removeObserver: async () => {},
      });

      // No repair channel, so gatekeeper 1's refusal is terminal -- and descriptive.
      await expect(impl.ensureObserver("alice", fakeClientUser, "build"))
          .rejects.toThrow(/could not confirm/);

      // The refused gatekeeper's coverage is scrubbed; the other's survives.
      let record = impl.storage.observers.get("alice");
      expect(1 in record.accountChoices).toBe(false);
      expect(record.accountChoices[2]).toBe(20);

      // The point of the scrub: alice's coverage shrank, so every live session is severed and
      // must re-open against what the record now claims.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(restarts).toHaveLength(1);

      // Neither producer's restricted reads are blocked, though -- both are verifiable, so
      // admission is the whole enforcement and nobody unverified can be watching.
      let restricted = { title: "t", description: "d", containsRestrictedData: true };
      await expect(impl.authorizeObservation(1, restricted, { from: "user" }))
          .resolves.toBeUndefined();
      await expect(impl.authorizeObservation(2, restricted, { from: "user" }))
          .resolves.toBeUndefined();
    });
  });

  it("a getVerifier rejection scrubs that gatekeeper's persisted coverage", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-coverage-scrub-getverifier");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      seedGatekeepers(impl);
      recordRestarts(impl);
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

      // No repair channel, so the failure is terminal -- and descriptive, not the raw RPC error.
      await expect(impl.ensureObserver("alice", failingClientUser, "build"))
          .rejects.toThrow(/could not confirm/);

      // The rejection went through fail(): gatekeeper 1's persisted coverage is scrubbed -- so
      // the record no longer claims this collaborator was verified for it -- while gatekeeper 2's
      // survives.
      let record = impl.storage.observers.get("alice");
      expect(1 in record.accountChoices).toBe(false);
      expect(record.accountChoices[2]).toBe(20);

      // Alice was already an admitted observer, so the failure de-registers her from nothing: the
      // registrations are what make gatekeepers name her in `excludeObservers`, and the scrub does
      // not cover the same observations (it gates `containsRestrictedData` only).
      expect(removed).toEqual([]);
    });
  });

  it("keeps a returning observer's registration so forward exclusion survives the failure",
      async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-coverage-scrub-keeps-registration");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      seedGatekeepers(impl);
      recordRestarts(impl);
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

      // The two registrations are treated differently, which is the whole point. Gatekeeper 1's
      // predates this call, so it survives and keeps naming her in `excludeObservers`. Gatekeeper
      // 2's was created by this call, so rolling it back merely restores the pre-call state --
      // there was no prior registration whose exclusions could be lost.
      expect(removed).toEqual([2]);
      // Coverage is still scrubbed regardless, so her next open must re-verify gatekeeper 1.
      expect(1 in impl.storage.observers.get("alice").accountChoices).toBe(false);
    });
  });

  it("a first-ever verification failure still rolls its registrations back", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-coverage-scrub-first-ever");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      seedGatekeepers(impl);
      recordRestarts(impl);
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
