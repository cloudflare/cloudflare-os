// What ensureObserver does with a binding it could not verify: every failure is collected and
// reported as a denial the user can act on, and a first-ever observer who fails is not persisted.
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

// Connections 1 and 2, each with a requirement recorded through it on the workspace.
function seedObservedGatekeepers(impl: ObserverImpl): void {
  for (let id of [1, 2]) {
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
    let actionId = impl.storage.nextActionId.get();
    impl.storage.nextActionId.put(actionId + 1);
    impl.storage.actions.put({
      id: actionId, gatekeeperId: id, caller: { from: "user" }, createdAt: new Date(0),
      state: "approved", type: "observation",
      description: { title: "Read", description: "A read", subresources: [`doc-${id}`] },
    });
  }
}

// Facets for every seeded connection, admitting every observer to every subresource except on
// connection `denying`.
function setObserverFacets(impl: ObserverImpl, denying?: number): void {
  const getFacet = async (id: number) => ({
    verifyObserverAccess: async (observers: { id: string }[]) =>
        ({ allowedObserverIds: id === denying ? [] : observers.map(observer => observer.id) }),
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

describe("a binding that fails verification", () => {
  it("reports a verifier rejection as a denial, not as the raw RPC error", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-verify-getverifier");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      seedOwner(impl);
      seedObservedGatekeepers(impl);
      // Already-configured coverage for both gatekeepers, as a previous successful open left it.
      let record = { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10, 2: 20 } };
      impl.storage.observers.put(record);
      setObserverFacets(impl);

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
      let admission = impl.ensureObserver("alice", failingClientUser, "workspace");
      await expect(admission).rejects.toThrow(/could not confirm/);
      await expect(admission).rejects.toThrow(/Connection 1/);
      expect(impl.storage.observers.get("alice")).toEqual(record);
    });
  });

  it.each(["verifier rejection", "disconnected account", "requirement denial"])(
      "persists no first-ever observer after %s", async failure => {
    let stub = env.TEST_OVERSEER.getByName(`observer-verify-first-ever-${failure}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      seedOwner(impl);
      seedObservedGatekeepers(impl);
      setObserverFacets(impl, failure === "requirement denial" ? 2 : undefined);
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

      await expect(impl.ensureObserver("alice", clientUser, "workspace", configureAll))
          .rejects.toThrow(/could not confirm/);
      expect(impl.storage.observers.get("alice")).toBeUndefined();
    });
  });
});
