// removalBlockedByRestrictedData() is the single predicate behind the producer-removal guard:
// GatekeeperClientImpl.remove() refuses on it, and ensureAmbientCapsules()'s reconciliation skips
// stale records on it. It must block exactly when deleting the record would readmit an unverified
// party -- the workspace is latched, the record is a restricted producer (verifiable or not), and
// the sharing graph still has collaborators or outstanding share links.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// git-migration-do.test.ts) so the predicate reads real storage; records are seeded directly
// through the impl.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER = "alice";

function getImpl(instance: OverseerDurableObject): any {
  let impl = (instance as unknown as { impl: any }).impl;
  // The sharing manager resolves collaborator reachability from the owner; seed the cached
  // profile id so no User DO round trip is attempted.
  impl.ownerProfileId = OWNER;
  return impl;
}

// A verifiable connection record, or (without `creationSpec`) a legacy one -- unverifiable, and
// guarded all the same.
function seedGatekeeper(impl: any, id: number, creationSpec = true): void {
  impl.storage.gatekeepers.put({
    id,
    resourceTitle: `Connection ${id}`,
    class: {} as any,
    ...(creationSpec ? {
      creationSpec: {
        type: "gatekeeper",
        vendorId: "testvendor",
        resourceUrl: `https://example.com/${id}`,
        typeUrlPattern: "https://*",
      },
    } : {}),
  });
}

// A restricted observation attributed to `gatekeeperId`, which is what makes it a producer
// (restrictedProducerIds scans the action log for exactly these).
function seedRestrictedObservation(impl: any, gatekeeperId: number, actionId: number): void {
  impl.storage.actions.put({
    id: actionId,
    gatekeeperId,
    caller: { from: "user" },
    createdAt: new Date(),
    state: "approved",
    type: "observation",
    description: {
      title: "Read a thing",
      description: "The test read a thing.",
      containsRestrictedData: true,
    },
  });
}

function seedCollaborator(impl: any): void {
  impl.storage.collaborators.put({
    profile: { id: "bob", name: "Bob" },
    addedBy: [{ type: "user", sharer: OWNER, created: new Date(), role: "build" }],
  });
}

function seedShareLink(impl: any): void {
  impl.storage.shareKeys.put({
    id: "link-1",
    created: new Date(),
    createdBy: OWNER,
    role: "build",
  });
}

describe("removalBlockedByRestrictedData", () => {
  it("does not block while the workspace is unlatched", async () => {
    let stub = env.TEST_OVERSEER.getByName("producer-removal-unlatched");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      seedRestrictedObservation(impl, 1, 100);
      seedCollaborator(impl);

      expect(impl.removalBlockedByRestrictedData(1, await impl.getSharingManager())).toBe(false);
    });
  });

  it("does not block a latched non-producer, even while shared", async () => {
    let stub = env.TEST_OVERSEER.getByName("producer-removal-non-producer");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      seedGatekeeper(impl, 2);
      seedRestrictedObservation(impl, 1, 100);
      impl.storage.prohibitAllSharing.put(true);
      seedCollaborator(impl);

      let sharing = await impl.getSharingManager();
      expect(impl.removalBlockedByRestrictedData(2, sharing)).toBe(false);
      expect(impl.removalBlockedByRestrictedData(1, sharing)).toBe(true);
    });
  });

  it("blocks a legacy (unverifiable) producer while a collaborator exists", async () => {
    let stub = env.TEST_OVERSEER.getByName("producer-removal-legacy");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1, /* creationSpec */ false);
      seedRestrictedObservation(impl, 1, 100);
      impl.storage.prohibitAllSharing.put(true);
      seedCollaborator(impl);

      // The legacy record is what denies every non-owner open (#inScopeGatekeepers throws on
      // it), so removing it while shared would readmit the collaborator unverified.
      expect(impl.removalBlockedByRestrictedData(1, await impl.getSharingManager())).toBe(true);
    });
  });

  it("blocks on an outstanding share link alone", async () => {
    let stub = env.TEST_OVERSEER.getByName("producer-removal-link-only");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      seedRestrictedObservation(impl, 1, 100);
      impl.storage.prohibitAllSharing.put(true);
      seedShareLink(impl);

      // No collaborator yet, but the link's keys are multi-redeemable and redemption is gated
      // only while the record exists.
      expect(impl.removalBlockedByRestrictedData(1, await impl.getSharingManager())).toBe(true);
    });
  });

  it("does not block a latched producer while the workspace is unshared", async () => {
    let stub = env.TEST_OVERSEER.getByName("producer-removal-unshared");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      seedRestrictedObservation(impl, 1, 100);
      impl.storage.prohibitAllSharing.put(true);

      expect(impl.removalBlockedByRestrictedData(1, await impl.getSharingManager())).toBe(false);
    });
  });

  it("falls back to guarding every connection when the latch is set with no producer", async () => {
    let stub = env.TEST_OVERSEER.getByName("producer-removal-empty-producers");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      // Should be impossible (the latch and its action record are written together), so fail
      // closed: with the latch set and no derivable producer set, everything is guarded.
      impl.storage.prohibitAllSharing.put(true);
      seedCollaborator(impl);

      expect(impl.removalBlockedByRestrictedData(1, await impl.getSharingManager())).toBe(true);
    });
  });
});

// GatekeeperClientImpl.remove() must make its decision against sharing state read *after* its
// only real yield (the cold sharing manager's whoami RPC) and in the same synchronous block as
// the delete: a grant landing during the yield is seen by the check, and nothing can land
// between the check and the delete. Pinned by parking whoami on a deferred so the yield is a
// real in-test suspension point.
describe("GatekeeperClientImpl.remove ordering", () => {
  it("sees a collaborator granted while the sharing manager is being fetched", async () => {
    let stub = env.TEST_OVERSEER.getByName("producer-removal-mid-yield-grant");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      // Not getImpl(): impl.ownerProfileId stays unset so getSharingManager() must fetch the
      // owner profile through the (stubbed) owner User DO -- the parked deferred below.
      let impl = (instance as unknown as { impl: any }).impl;
      let releaseWhoami!: (profile: { id: string; name: string }) => void;
      let whoami = new Promise<{ id: string; name: string }>(resolve => {
        releaseWhoami = resolve;
      });
      impl.ownerId = "owner-do-id";
      impl.users = {
        idFromString: (id: string) => id,
        get: () => ({ whoami: () => whoami }),
      };
      impl.getGatekeeperFacet = () => ({
        describe: async () => ({ title: "Producer", url: "test://producer" }),
      });

      // A real client for a real record, so the test drives the actual remove() path.
      let client = await impl.addGatekeeper({} as any, {
        type: "gatekeeper",
        vendorId: "testvendor",
        resourceUrl: "https://example.com/producer",
        typeUrlPattern: "https://*",
      });
      let id = await client.getId();
      seedRestrictedObservation(impl, id, 100);
      impl.storage.prohibitAllSharing.put(true);

      // Start the removal: it runs synchronously up to the parked whoami. Grant a collaborator
      // mid-park, then release -- the decision must see the grant and refuse.
      let removal = client.remove();
      seedCollaborator(impl);
      releaseWhoami({ id: OWNER, name: "Alice" });

      await expect(removal).rejects.toThrow(/cannot be removed/);
      expect(impl.storage.gatekeepers.get(id)).toBeDefined();
    });
  });
});

// The ambient reconciliation removes a capsule record whose account is gone or was replaced --
// an internal removal that must consult the same guard: a stale record that is a restricted
// producer still anchors collaborator verification.
describe("ensureAmbientCapsules reconciliation", () => {
  const AMBIENT_ID = 1;

  // Seeds a stale ambient producer (record bound to accountId 10, owner now holding accountId
  // 20) plus the latch, and fakes the owner's User DO and the gatekeeper facet so
  // ensureAmbientCapsules can run without any real cross-DO call.
  function seedStaleAmbientProducer(impl: any): void {
    impl.storage.gatekeepers.put({
      id: AMBIENT_ID,
      resourceTitle: "Test Ambient",
      class: {} as any,
      creationSpec: { type: "ambient", vendorId: "testvendor", accountId: 10 },
    });
    // Keep freshly-provisioned records clear of the seeded id.
    impl.storage.nextGatekeeperId.put(10);
    seedRestrictedObservation(impl, AMBIENT_ID, 100);
    impl.storage.prohibitAllSharing.put(true);

    impl.ownerId = "owner-do-id";
    impl.users = {
      idFromString: (id: string) => id,
      get: () => ({
        listProvidedAccounts: async () => [{
          vendorId: "testvendor",
          accountId: 20,
          description: { singleton: { tsType: "TestThing" } },
        }],
        getSingletonGatekeeperClass: async () => ({} as any),
      }),
    };
    impl.getGatekeeperFacet = () => ({
      describe: async () => ({ title: "Test Ambient", url: "test://ambient" }),
    });
  }

  function ambientRecords(impl: any): { id: number; accountId: number }[] {
    return [...impl.storage.gatekeepers.list()]
        .filter((gk: any) => gk.creationSpec?.type === "ambient")
        .map((gk: any) => ({ id: gk.id, accountId: gk.creationSpec.accountId }));
  }

  it("keeps a guarded stale producer and still provisions the replacement", async () => {
    let stub = env.TEST_OVERSEER.getByName("ambient-reconcile-guarded");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedStaleAmbientProducer(impl);
      seedCollaborator(impl);

      await impl.ensureAmbientCapsules();

      // The stale record anchors the collaborator's verification, so it survives; the
      // replacement account still gets its own fresh capsule record.
      let records = ambientRecords(impl);
      expect(records).toContainEqual({ id: AMBIENT_ID, accountId: 10 });
      expect(records.filter(r => r.accountId === 20)).toHaveLength(1);
    });
  });

  it("still reconciles a stale producer away while the workspace is unshared", async () => {
    let stub = env.TEST_OVERSEER.getByName("ambient-reconcile-unshared");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedStaleAmbientProducer(impl);

      await impl.ensureAmbientCapsules();

      let records = ambientRecords(impl);
      expect(records.find(r => r.id === AMBIENT_ID)).toBeUndefined();
      expect(records.filter(r => r.accountId === 20)).toHaveLength(1);
    });
  });
});

// assertNewSharingAllowed() must refuse every new grant once a restricted producer cannot verify
// collaborators -- whether its record is gone, is legacy (no creationSpec; observerVendorId
// throws, so recipients hard-deny at open while the grant blocks producer removal), or is an
// aiModel/agentSpawner producer with no vendor account (filtered out of every verification scope,
// so recipients would open completely unverified and read the restricted history in chat).
describe("assertNewSharingAllowed", () => {
  it("allows sharing while a verifiable producer's record survives", async () => {
    let stub = env.TEST_OVERSEER.getByName("sharing-allowed-verifiable");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      seedRestrictedObservation(impl, 1, 100);
      impl.storage.prohibitAllSharing.put(true);

      expect(() => impl.assertNewSharingAllowed()).not.toThrow();
    });
  });

  it("refuses when a producer's record has been removed", async () => {
    let stub = env.TEST_OVERSEER.getByName("sharing-allowed-removed");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedRestrictedObservation(impl, 1, 100);
      impl.storage.prohibitAllSharing.put(true);

      expect(() => impl.assertNewSharingAllowed()).toThrow(/has since been removed/);
    });
  });

  it("refuses a legacy producer that cannot verify collaborators", async () => {
    let stub = env.TEST_OVERSEER.getByName("sharing-allowed-legacy");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1, /* creationSpec */ false);
      seedRestrictedObservation(impl, 1, 100);
      impl.storage.prohibitAllSharing.put(true);

      expect(() => impl.assertNewSharingAllowed()).toThrow(/cannot verify collaborators/);
    });
  });

  it("refuses an aiModel producer that cannot verify collaborators", async () => {
    let stub = env.TEST_OVERSEER.getByName("sharing-allowed-ai-model");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      impl.storage.gatekeepers.put({
        id: 1,
        resourceTitle: "AI model",
        class: {} as any,
        creationSpec: {
          type: "aiModel", modelId: "m-1", provider: "anthropic", modelName: "claude-sonnet-5",
        },
      });
      seedRestrictedObservation(impl, 1, 100);
      impl.storage.prohibitAllSharing.put(true);

      // No vendor account stands behind the producer (observerVendorId returns null), so no
      // recipient could ever be verified against it.
      expect(() => impl.assertNewSharingAllowed()).toThrow(/cannot verify collaborators/);
    });
  });

  it("never refuses while the workspace is unlatched", async () => {
    let stub = env.TEST_OVERSEER.getByName("sharing-allowed-unlatched");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      // Even a restricted-looking observation through a missing record does not refuse without
      // the latch: the latch and the record are written together, so unlatched means none.
      seedRestrictedObservation(impl, 1, 100);

      expect(() => impl.assertNewSharingAllowed()).not.toThrow();
    });
  });
});
