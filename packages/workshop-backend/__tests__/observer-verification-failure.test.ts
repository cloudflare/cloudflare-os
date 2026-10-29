// What ensureObserver does with a binding it could not verify: every failure is collected and
// reported as a denial the user can act on, and nothing the call did not create is torn down.
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

// A read of `subresource` reported by a user outside any chat, which records a requirement on the
// workspace context.
function seedWorkspaceRequirement(impl: ObserverImpl, gatekeeperId: number, subresource: string): void {
  impl.observerLedger.recordObservation({
    gatekeeperId, caller: { from: "user" }, createdAt: new Date(), state: "approved",
    type: "observation",
    description: { title: "Read", description: "A read reporting subresources.",
                   subresources: [subresource] },
  });
}

// A vendor's verifier for one account: answers which of `ids` it cannot read, through a
// vendor-specific method only its gatekeeper calls.
type VendorVerifier = { deniedSubresources(ids: string[]): Promise<string[]> };

// Facets for every seeded connection: each registers observers through `hooks`, and verifies
// recorded requirements by admitting each observer whose verifier denies none of the IDs.
function setObserverFacets(impl: ObserverImpl, hooks: {
  addObserver?(id: number, observerId: string): Promise<void>;
  removeObserver?(id: number): Promise<void>;
} = {}): void {
  const getFacet = async (id: number) => ({
    describe: async () => ({}),
    addObserver: async (observerId: string) => { await hooks.addObserver?.(id, observerId); },
    removeObserver: async () => { await hooks.removeObserver?.(id); },
    verifyObserverAccess: async (observers: {id: string, verifier: VendorVerifier}[],
                                 ids: string[]) => {
      let denied = await Promise.all(
          observers.map(observer => observer.verifier.deniedSubresources(ids)));
      return { allowedObserverIds: observers.filter((_, i) => denied[i].length === 0)
          .map(observer => observer.id) };
    },
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
      await expect(impl.ensureObserver("alice", failingClientUser, "build"))
          .rejects.toThrow(/could not confirm/);

      // Alice was already an admitted observer, so this call registered nothing and there is
      // nothing for the rollback to remove. Her registrations are what make gatekeepers name her
      // in `excludeObservers`, so dropping one would be fail-open.
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

      await expect(impl.ensureObserver("alice", fakeClientUser, "build", configureAll))
          .rejects.toThrow(/could not confirm/);

      // Gatekeeper 1's registration predates this call and survives, so it keeps naming her in
      // `excludeObservers`. Gatekeeper 2's was created by this call, but Alice's persisted
      // observerId remains resolvable to exclusion checks too: de-registering is the fail-open
      // direction, and a spurious registration only blocks fail-closed until a later open
      // re-verifies it.
      expect(removed).toEqual([]);
    });
  });

  it("queues a successful open after a failed one without blocking another profile", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-verify-concurrent");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      seedOwner(impl);
      seedGatekeepers(impl, [1, 2, 3]);
      impl.storage.observers.put(
          { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10 } });

      let removed: number[] = [];
      let releaseVerifier!: () => void;
      let verifierParked = new Promise<void>(resolve => { releaseVerifier = resolve; });
      let reached!: () => void;
      let verifierReached = new Promise<void>(resolve => { reached = resolve; });
      let firstAttempt = true;
      let parkingClientUser = {
        getVerifier: async (accountId: number) => {
          if (accountId === 30) {
            if (firstAttempt) {
              firstAttempt = false;
              reached();
              await verifierParked;
            }
            throw new Error("no access");
          }
          return {};
        },
        describeConnectedAccount: async () => null,
      } as unknown as ObserverClientUser;
      setObserverFacets(impl, { removeObserver: async id => { removed.push(id); } });

      let callA = impl.ensureObserver("alice", parkingClientUser, "build", configureAll);
      callA.catch(() => {});  // asserted below; not unhandled while its verifier is parked
      await verifierReached;

      let queuedPrompts = 0;
      let queuedConfig = {
        configure: async (needs: {gatekeeperId: number}[]) => {
          queuedPrompts++;
          return configureAll.configure(needs);
        },
      } as unknown as ObserverConfigureCallback;
      let callB = impl.ensureObserver("alice", fakeClientUser, "build", queuedConfig);

      // Bob can finish while Alice's first open is parked, but her second open cannot prompt yet.
      await impl.ensureObserver("bob", fakeClientUser, "build", configureAll);
      let queuedPromptsBeforeRelease = queuedPrompts;
      let choicesBeforeRelease = impl.storage.observers.get("alice")?.accountChoices;

      releaseVerifier();
      await expect(callA).rejects.toThrow(/could not confirm/);
      await callB;

      expect(impl.storage.observers.get("bob")).toBeDefined();
      expect(queuedPromptsBeforeRelease).toBe(0);
      expect(choicesBeforeRelease).toEqual({ 1: 10 });
      expect(queuedPrompts).toBe(1);
      expect(removed).toEqual([]);
      expect(impl.storage.observers.get("alice")).toEqual({
        profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10, 2: 20, 3: 30 },
      });
    });
  });

  it.each(["verifier rejection", "disconnected account", "registration refusal"])(
      "rolls back a first-ever observer after %s", async failure => {
    let stub = env.TEST_OVERSEER.getByName(`observer-verify-first-ever-${failure}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      seedOwner(impl);
      seedGatekeepers(impl);
      let removed: number[] = [];
      setObserverFacets(impl, {
        addObserver: async id => {
          if (id === 2 && failure === "registration refusal") throw new Error("no access");
        },
        removeObserver: async id => { removed.push(id); },
      });
      let clientUser = {
        getVerifier: async (accountId: number) => {
          if (accountId === 20) {
            if (failure === "verifier rejection") throw new Error("verifier unavailable");
            if (failure === "disconnected account") return null;
          }
          return {};
        },
        describeConnectedAccount: async () => null,
      } as unknown as ObserverClientUser;

      await expect(impl.ensureObserver("alice", clientUser, "build", configureAll))
          .rejects.toThrow(/could not confirm/);

      // Both the one that verified and the one that refused are rolled back, and no record is
      // persisted.
      expect(removed.toSorted()).toEqual([1, 2]);
      expect(impl.storage.observers.get("alice")).toBeUndefined();
    });
  });

  it("removes a first-ever observer's registration when a recorded requirement denies her",
      async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-verify-first-ever-requirement");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      seedOwner(impl);
      seedGatekeepers(impl);
      seedWorkspaceRequirement(impl, 2, "secret/read");
      let registered: number[] = [];
      let removed: number[] = [];
      setObserverFacets(impl, {
        addObserver: async id => { registered.push(id); },
        removeObserver: async id => { removed.push(id); },
      });
      const clientUser = {
        getVerifier: async (): Promise<VendorVerifier> => ({
          deniedSubresources: async (ids: string[]) => ids,
        }),
        describeConnectedAccount: async () => null,
      } as unknown as ObserverClientUser;

      await expect(impl.ensureObserver("alice", clientUser, "build", configureAll))
          .rejects.toThrow(/could not confirm/);

      // addObserver() accepted her on both connections (on each pass, the re-prompt included),
      // but connection 2's recorded read is one she cannot see, so every registration this call
      // made is removed and nothing persists.
      expect([...new Set(registered)].toSorted()).toEqual([1, 2]);
      expect(removed.toSorted()).toEqual([1, 2]);
      expect(impl.storage.observers.get("alice")).toBeUndefined();
    });
  });

  it("rolls back registrations from earlier repaired attempts after a later failure", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-verify-repaired-rollback");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      seedOwner(impl);
      seedGatekeepers(impl);
      let attempts = new Map<number, number>();
      let removed: number[] = [];
      setObserverFacets(impl, {
        addObserver: async id => {
          let attempt = (attempts.get(id) ?? 0) + 1;
          attempts.set(id, attempt);
          if ((id === 1 && attempt === 1) || (id === 2 && attempt === 2)) {
            throw new Error("no access");
          }
        },
        removeObserver: async id => { removed.push(id); },
      });

      await expect(impl.ensureObserver("alice", fakeClientUser, "build", configureAll))
          .rejects.toThrow(/could not confirm/);

      expect(attempts.get(1)).toBe(2);
      expect(attempts.get(2)).toBe(2);
      expect(removed.toSorted()).toEqual([1, 2]);
      expect(impl.storage.observers.get("alice")).toBeUndefined();
    });
  });

  it.each(["without requirements", "with recorded requirements"])(
      "reuses one observer identity for first-ever concurrent successful opens in %s workspaces",
      async workspace => {
    let stub = env.TEST_OVERSEER.getByName(
        `observer-verify-first-concurrent-${workspace.replaceAll(" ", "-")}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      seedOwner(impl);
      seedGatekeepers(impl);
      if (workspace === "with recorded requirements") seedWorkspaceRequirement(impl, 2, "read");
      let registrations: {id: number, observerId: string}[] = [];
      setObserverFacets(impl, {
        addObserver: async (id, observerId) => { registrations.push({id, observerId}); },
      });
      let checks: {accountId: number, ids: string[]}[] = [];
      // The same direct-DO user double serves registration and requirement checks.
      const clientUser = {
        getVerifier: async (accountId: number): Promise<VendorVerifier> => ({
          deniedSubresources: async (ids: string[]) => {
            checks.push({accountId, ids});
            return [];
          },
        }),
        describeConnectedAccount: async () => null,
      } as unknown as ObserverClientUser;
      let release!: () => void;
      let reached!: () => void;
      let parked = new Promise<void>(resolve => { release = resolve; });
      let prompted = new Promise<void>(resolve => { reached = resolve; });
      let firstPrompts = 0;
      // These local callbacks stand in for the client RPC callbacks on the direct DO call.
      const firstConfig = {
        configure: async (needs: {gatekeeperId: number}[]) => {
          firstPrompts++;
          reached();
          await parked;
          return configureAll.configure(needs);
        },
      } as unknown as ObserverConfigureCallback;
      let secondPrompts = 0;
      const secondConfig = {
        configure: async (needs: {gatekeeperId: number}[]) => {
          secondPrompts++;
          return configureAll.configure(needs);
        },
      } as unknown as ObserverConfigureCallback;

      let callA = impl.ensureObserver("alice", clientUser, "build", firstConfig);
      await prompted;
      let callB = impl.ensureObserver("alice", clientUser, "build", secondConfig);

      // Another profile makes progress while Alice chooses, without opening her second prompt.
      await impl.ensureObserver("bob", clientUser, "build", configureAll);
      let secondPromptsBeforeRelease = secondPrompts;
      let observerBeforeRelease = impl.storage.observers.get("alice");

      release();
      await Promise.all([callA, callB]);

      let alice = impl.storage.observers.get("alice")!;
      let bob = impl.storage.observers.get("bob")!;
      let aliceRegistrations = registrations.filter(entry => entry.observerId !== bob.observerId);
      expect(secondPromptsBeforeRelease).toBe(0);
      expect(observerBeforeRelease).toBeUndefined();
      expect(firstPrompts).toBe(1);
      expect(secondPrompts).toBe(0);
      expect(alice.accountChoices).toEqual({ 1: 10, 2: 20 });
      expect(aliceRegistrations.length).toBeGreaterThanOrEqual(2);
      expect(new Set(aliceRegistrations.map(entry => entry.id))).toEqual(new Set([1, 2]));
      expect(aliceRegistrations.every(entry => entry.observerId === alice.observerId)).toBe(true);
      if (workspace === "with recorded requirements") {
        expect(checks.length).toBeGreaterThanOrEqual(2);
        expect(checks.every(check => check.accountId === 20 && check.ids.join() === "read"))
            .toBe(true);
      } else {
        expect(checks).toEqual([]);
      }
    });
  });

  it("releases the profile queue when account selection is refused", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-verify-queue-refusal");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      seedOwner(impl);
      seedGatekeepers(impl);
      setObserverFacets(impl);
      let release!: () => void;
      let reached!: () => void;
      let parked = new Promise<void>(resolve => { release = resolve; });
      let prompted = new Promise<void>(resolve => { reached = resolve; });
      // A rejected client RPC must release the same queue as a verifier refusal.
      const refusingConfig = {
        configure: async () => {
          reached();
          await parked;
          throw new Error("account selection refused");
        },
      } as unknown as ObserverConfigureCallback;

      let refused = impl.ensureObserver("alice", fakeClientUser, "build", refusingConfig);
      refused.catch(() => {});
      await prompted;
      let admitted = impl.ensureObserver("alice", fakeClientUser, "build", configureAll);
      release();

      await expect(refused).rejects.toThrow("account selection refused");
      await admitted;
      expect(impl.storage.observers.get("alice")?.accountChoices).toEqual({ 1: 10, 2: 20 });
    });
  });

  it("admits against live requirements when an observed connection is removed during its prompt", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-verify-removed-during-prompt");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      seedOwner(impl);
      seedGatekeepers(impl);
      seedWorkspaceRequirement(impl, 2, "live/read");
      let checkedAccounts: number[] = [];
      let checks: string[][] = [];
      const clientUser = {
        getVerifier: async (accountId: number): Promise<VendorVerifier> => {
          checkedAccounts.push(accountId);
          if (accountId === 10) throw new Error("Removed connection must not be checked");
          return {
            deniedSubresources: async (ids: string[]) => {
              checks.push(ids);
              return ids.filter(id => id !== "live/read");
            },
          };
        },
        describeConnectedAccount: async () => null,
      } as unknown as ObserverClientUser;
      let removed: number[] = [];
      setObserverFacets(impl, { removeObserver: async id => { removed.push(id); } });
      let release!: () => void;
      let reached!: () => void;
      let parked = new Promise<void>(resolve => { release = resolve; });
      let prompted = new Promise<void>(resolve => { reached = resolve; });
      // This local callback keeps the real admission parked across the connection removal.
      const config = {
        configure: async (needs: {gatekeeperId: number}[]) => {
          reached();
          await parked;
          return configureAll.configure(needs);
        },
      } as unknown as ObserverConfigureCallback;

      let admission = impl.ensureObserver("alice", clientUser, "build", config);
      await prompted;
      impl.removeGatekeeper(1);
      release();

      await admission;
      expect(impl.storage.observers.get("alice")?.accountChoices[2]).toBe(20);
      expect(checkedAccounts).toContain(20);
      expect(checkedAccounts).not.toContain(10);
      expect(checks.length).toBeGreaterThan(0);
      expect(checks.every(ids => ids.length === 1 && ids[0] === "live/read")).toBe(true);
      expect(impl.listObserverRequirements("build").map(need => need.gatekeeperId)).toEqual([2]);
      expect(removed).toEqual([]);
    });
  });
});
