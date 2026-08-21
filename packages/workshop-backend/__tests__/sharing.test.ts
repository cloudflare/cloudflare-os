import { describe, it, expect } from "vitest";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import {
  SharingManager,
  SharingStorage,
  CollaboratorRecord,
  ShareKeyRecord,
} from "../src/sharing.js";
import { AiChatAuthorInfo, PermissionEdge, CollaboratorRole } from "@gadgets/workshop-shared/api";
import { makeMockStorage } from "./mock-storage.js";

function makeStorage(): SharingStorage {
  return createTypedStorage(makeMockStorage(), {
    collections: {
      collaborators: collection<CollaboratorRecord>()({
        primaryKey: (record: CollaboratorRecord) => record.profile.id,
      }),
      shareKeys: collection<ShareKeyRecord>()({
        primaryKey: "id",
        nonUniqueIndexes: {
          byAlias(record: ShareKeyRecord) { return record.alias ?? null; }
        }
      }),
    },
  });
}

const OWNER = "owner@example.com";

function makeManager(): { storage: SharingStorage; mgr: SharingManager } {
  let storage = makeStorage();
  return { storage, mgr: new SharingManager(storage, OWNER) };
}

function profile(id: string): AiChatAuthorInfo {
  return { type: "user", id, name: id };
}

function userEdge(sharer: string, role: CollaboratorRole = "build"): PermissionEdge {
  return { type: "user", sharer, created: new Date(), role };
}

function keyEdge(keyId: string, role: CollaboratorRole = "build"): PermissionEdge {
  return { type: "shareKey", keyId, created: new Date(), role };
}

function pendingKeyEdge(keyId: string, role: CollaboratorRole = "build"): PermissionEdge {
  return { type: "shareKey", keyId, created: new Date(), role, pending: true };
}

// Redeem `rawKey` for `profileId` and confirm the redemption, as a successful open() does.
// Redemption alone adds only a pending edge, which grants nothing.
async function redeemConfirmed(
    mgr: SharingManager, rawKey: string, profileId: string): Promise<string | null> {
  let linkId = await mgr.redeemShareKey({
    rawKey, profileId, fetchProfile: async () => profile(profileId),
  });
  if (linkId !== null) mgr.confirmShareKeyRedemption(profileId, linkId);
  return linkId;
}

function seedCollaborator(storage: SharingStorage, id: string, addedBy: PermissionEdge[]) {
  storage.collaborators.put({ profile: profile(id), addedBy });
}

// Seed a share link. A link is stored as its first key, so `linkId` is that key's hash -- which is
// what `shareKey` edges reference.
function seedLink(
    storage: SharingStorage, linkId: string, createdBy: string, role: CollaboratorRole = "build") {
  storage.shareKeys.put({ id: linkId, created: new Date(), createdBy, role });
}

// Read back a link record, asserting that the id names a link rather than one of its aliases.
function link(storage: SharingStorage, linkId: string) {
  let record = storage.shareKeys.get(linkId)!;
  if (record.alias !== undefined) throw new Error(`${linkId} is an alias, not a link`);
  return record;
}

function ids(list: { profile: AiChatAuthorInfo }[]): string[] {
  return list.map(x => x.profile.id).toSorted();
}

const owner = { profileId: OWNER, isOwner: true };
function collab(id: string) {
  return { profileId: id, isOwner: false };
}

describe("authorization", () => {
  it("isCollaborator reflects the collaborators table", () => {
    let { storage, mgr } = makeManager();
    expect(mgr.isCollaborator("a")).toBe(false);
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    expect(mgr.isCollaborator("a")).toBe(true);
  });

  it("getEffectiveRole returns build for the owner", () => {
    let { mgr } = makeManager();
    expect(mgr.getEffectiveRole(OWNER)).toBe("build");
  });

  it("getEffectiveRole returns undefined for non-collaborators", () => {
    let { mgr } = makeManager();
    expect(mgr.getEffectiveRole("nobody")).toBeUndefined();
  });

  it("getEffectiveRole reflects the granted role", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "build")]);
    expect(mgr.getEffectiveRole("a")).toBe("use");
    expect(mgr.getEffectiveRole("b")).toBe("build");
  });
});

describe("redeemShareKey", () => {
  it("creates a new collaborator (fetching profile) when the key is valid", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareLink({ caller: owner, role: "build" });

    let fetched = 0;
    await mgr.redeemShareKey({
      rawKey: key,
      profileId: "newbie",
      fetchProfile: async () => { fetched++; return profile("newbie"); },
    });

    expect(fetched).toBe(1);
    let rec = storage.collaborators.get("newbie")!;
    expect(rec.addedBy).toEqual([expect.objectContaining({ type: "shareKey", role: "build" })]);
  });

  it("stamps the redeemed edge with the key's role", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareLink({ caller: owner, role: "use" });

    await redeemConfirmed(mgr, key, "a");

    expect(storage.collaborators.get("a")!.addedBy)
        .toEqual([expect.objectContaining({ type: "shareKey", role: "use" })]);
    expect(mgr.getEffectiveRole("a")).toBe("use");
  });

  it("adds a key edge to an existing collaborator without fetching the profile", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareLink({ caller: owner, role: "build" });
    seedCollaborator(storage, "a", [userEdge(OWNER)]);

    let fetched = 0;
    await mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => { fetched++; return profile("a"); },
    });

    expect(fetched).toBe(0);
    expect(storage.collaborators.get("a")!.addedBy).toHaveLength(2);
  });

  it("does not duplicate an edge for the same key", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareLink({ caller: owner, role: "build" });

    await redeemConfirmed(mgr, key, "a");
    await redeemConfirmed(mgr, key, "a");

    expect(storage.collaborators.get("a")!.addedBy).toHaveLength(1);
  });

  it("is a no-op for an unknown key", async () => {
    let { storage, mgr } = makeManager();
    // A syntactically-valid raw key (hex) that was never created.
    await mgr.redeemShareKey({
      rawKey: "00112233445566778899aabbccddeeff", profileId: "a",
      fetchProfile: async () => profile("a"),
    });
    expect(storage.collaborators.get("a")).toBeUndefined();
  });

  it("returns the link id while there is a pending edge to settle, null once confirmed", async () => {
    let { mgr } = makeManager();
    let { key, linkId } = await mgr.createShareLink({ caller: owner, role: "build" });

    let redeem = () => mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => profile("a"),
    });
    await expect(redeem()).resolves.toBe(linkId);  // added a pending edge
    await expect(redeem()).resolves.toBe(linkId);  // still pending -> this attempt settles it too
    mgr.confirmShareKeyRedemption("a", linkId);
    await expect(redeem()).resolves.toBeNull();    // confirmed edge -> nothing to settle

    await expect(mgr.redeemShareKey({
      rawKey: "00112233445566778899aabbccddeeff", profileId: "b",
      fetchProfile: async () => profile("b"),
    })).resolves.toBeNull();  // unknown key
  });

  it("revertShareKeyRedemption makes a brand-new recipient unreachable again", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareLink({ caller: owner, role: "build" });

    let redeemed = await mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => profile("a"),
    });
    mgr.revertShareKeyRedemption("a", redeemed!);

    // The record lingers edge-less (lazy model), granting nothing.
    expect(storage.collaborators.get("a")!.addedBy).toEqual([]);
    expect(mgr.getEffectiveRole("a")).toBeUndefined();
    expect(ids(mgr.listCollaborators())).toEqual([]);
  });

  it("a redemption that raced a completed one merges instead of clobbering", async () => {
    let { storage, mgr } = makeManager();
    let { key, linkId } = await mgr.createShareLink({ caller: owner, role: "build" });

    // While A's redemption is fetching the profile (the one await), a concurrent redemption of
    // the same key completes fully -- redeem plus confirm. A's re-read after the await must find
    // that record and settle against it, not overwrite it with a fresh pending edge.
    let result = await mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => {
        await redeemConfirmed(mgr, key, "a");
        return profile("a");
      },
    });

    // The confirmed edge means there is nothing for A to settle...
    expect(result).toBeNull();
    let edges = storage.collaborators.get("a")!.addedBy;
    expect(edges).toEqual([expect.objectContaining({ type: "shareKey", keyId: linkId })]);
    expect(edges[0]).not.toHaveProperty("pending");

    // ...and A's failed-verification revert (which only severs pending edges) leaves the
    // concurrent open's grant intact.
    mgr.revertShareKeyRedemption("a", linkId);
    expect(storage.collaborators.get("a")!.addedBy).toHaveLength(1);
    expect(mgr.getEffectiveRole("a")).toBe("build");
  });

  it("a redemption that raced a still-pending one settles the shared edge", async () => {
    let { storage, mgr } = makeManager();
    let { key, linkId } = await mgr.createShareLink({ caller: owner, role: "build" });

    // The concurrent redemption is still mid-verification: its pending edge is found on the
    // re-read, not duplicated, and A gets the link id back so it settles the edge itself.
    let result = await mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => {
        await mgr.redeemShareKey({
          rawKey: key, profileId: "a", fetchProfile: async () => profile("a"),
        });
        return profile("a");
      },
    });

    expect(result).toBe(linkId);
    expect(storage.collaborators.get("a")!.addedBy).toEqual(
        [expect.objectContaining({ type: "shareKey", keyId: linkId, pending: true })]);
  });

  it("revertShareKeyRedemption severs only the redeemed edge", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareLink({ caller: owner, role: "build" });
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);

    let redeemed = await mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => profile("a"),
    });
    // The pending grant is visible only to the verifying open itself.
    expect(mgr.getEffectiveRole("a")).toBe("use");
    expect(mgr.getEffectiveRole("a", redeemed!)).toBe("build");

    mgr.revertShareKeyRedemption("a", redeemed!);

    // The pre-existing user edge survives; only the shareKey grant is gone.
    expect(storage.collaborators.get("a")!.addedBy).toEqual([
      expect.objectContaining({ type: "user", sharer: OWNER, role: "use" }),
    ]);
    expect(mgr.getEffectiveRole("a")).toBe("use");
  });

  it("a throwing assertGrantAllowed rejects a new recipient with nothing persisted", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareLink({ caller: owner, role: "build" });

    await expect(mgr.redeemShareKey({
      rawKey: key, profileId: "a", fetchProfile: async () => profile("a"),
      assertGrantAllowed: () => { throw new Error("sharing is closed"); },
    })).rejects.toThrow(/sharing is closed/);

    // No collaborator record and no edge were written.
    expect(storage.collaborators.get("a")).toBeUndefined();
  });

  it("does not invoke assertGrantAllowed for an already-confirmed edge", async () => {
    let { mgr } = makeManager();
    let { key } = await mgr.createShareLink({ caller: owner, role: "build" });
    await redeemConfirmed(mgr, key, "a");

    // A confirmed edge is an existing grant, not a new one: the redemption stays a no-op even
    // when policy forbids new sharing (a collaborator re-opening with a retained key).
    await expect(mgr.redeemShareKey({
      rawKey: key, profileId: "a", fetchProfile: async () => profile("a"),
      assertGrantAllowed: () => { throw new Error("sharing is closed"); },
    })).resolves.toBeNull();
  });

  it("gates settling a still-pending edge, leaving it untouched on refusal", async () => {
    let { storage, mgr } = makeManager();
    let { key, linkId } = await mgr.createShareLink({ caller: owner, role: "build" });
    await mgr.redeemShareKey({
      rawKey: key, profileId: "a", fetchProfile: async () => profile("a"),
    });

    // Settling a pending edge completes a new grant, so it is refused too.
    await expect(mgr.redeemShareKey({
      rawKey: key, profileId: "a", fetchProfile: async () => profile("a"),
      assertGrantAllowed: () => { throw new Error("sharing is closed"); },
    })).rejects.toThrow(/sharing is closed/);

    // The pre-existing pending edge survives for its own open to settle.
    expect(storage.collaborators.get("a")!.addedBy).toEqual([
      expect.objectContaining({ type: "shareKey", keyId: linkId, pending: true }),
    ]);
  });

  it("invokes a passing assertGrantAllowed once and writes the pending edge", async () => {
    let { storage, mgr } = makeManager();
    let { key, linkId } = await mgr.createShareLink({ caller: owner, role: "build" });

    let calls = 0;
    await expect(mgr.redeemShareKey({
      rawKey: key, profileId: "a", fetchProfile: async () => profile("a"),
      assertGrantAllowed: () => { calls++; },
    })).resolves.toBe(linkId);

    expect(calls).toBe(1);
    expect(storage.collaborators.get("a")!.addedBy).toEqual([
      expect.objectContaining({ type: "shareKey", keyId: linkId, pending: true }),
    ]);
  });
});

describe("pending redemptions", () => {
  it("a pending redemption grants nothing until confirmed", async () => {
    let { storage, mgr } = makeManager();
    let { key, linkId } = await mgr.createShareLink({ caller: owner, role: "build" });
    await mgr.redeemShareKey({
      rawKey: key, profileId: "a", fetchProfile: async () => profile("a"),
    });

    // The edge exists but is pending: invisible to roles, listings, and downstream grants.
    expect(storage.collaborators.get("a")!.addedBy)
        .toEqual([expect.objectContaining({ type: "shareKey", keyId: linkId, pending: true })]);
    expect(mgr.getEffectiveRole("a")).toBeUndefined();
    expect(ids(mgr.listCollaborators())).toEqual([]);
    seedCollaborator(storage, "b", [userEdge("a")]);
    expect(mgr.getEffectiveRole("b")).toBeUndefined();

    mgr.confirmShareKeyRedemption("a", linkId);
    expect(mgr.getEffectiveRole("a")).toBe("build");
    expect(ids(mgr.listCollaborators())).toEqual(["a", "b"]);
  });

  it("assumePendingLink models the grant only for the verifying profile", async () => {
    let { storage, mgr } = makeManager();
    let { key, linkId } = await mgr.createShareLink({ caller: owner, role: "build" });
    await mgr.redeemShareKey({
      rawKey: key, profileId: "c", fetchProfile: async () => profile("c"),
    });

    // The verifying open counts its own pending edge...
    expect(mgr.getEffectiveRole("c", linkId)).toBe("build");
    // ...but the edge contributes nothing to anyone else's role, even in the same computation:
    // a user downstream of c stays unreachable when the open verifying a different profile asks.
    seedCollaborator(storage, "a", [userEdge("c")]);
    expect(mgr.getEffectiveRole("a", linkId)).toBeUndefined();
  });

  it("assumePendingLink is bounded by the link creator's effective role", () => {
    let { storage, mgr } = makeManager();
    // "s" created a build link but is themselves only a "use" collaborator.
    seedCollaborator(storage, "s", [userEdge(OWNER, "use")]);
    seedLink(storage, "k1", "s", "build");
    seedCollaborator(storage, "a", [pendingKeyEdge("k1", "build")]);
    expect(mgr.getEffectiveRole("a", "k1")).toBe("use");
  });

  it("assumePendingLink grants nothing for a revoked link", async () => {
    let { mgr } = makeManager();
    let { key, linkId } = await mgr.createShareLink({ caller: owner, role: "build" });
    await mgr.redeemShareKey({
      rawKey: key, profileId: "a", fetchProfile: async () => profile("a"),
    });
    mgr.revokeShareLink(owner, linkId, []);
    expect(mgr.getEffectiveRole("a", linkId)).toBeUndefined();
  });

  it("confirmShareKeyRedemption clears the pending flag and is idempotent", async () => {
    let { storage, mgr } = makeManager();
    let { key, linkId } = await mgr.createShareLink({ caller: owner, role: "use" });
    await mgr.redeemShareKey({
      rawKey: key, profileId: "a", fetchProfile: async () => profile("a"),
    });

    mgr.confirmShareKeyRedemption("a", linkId);
    mgr.confirmShareKeyRedemption("a", linkId);

    let edges = storage.collaborators.get("a")!.addedBy;
    expect(edges).toEqual([expect.objectContaining({ type: "shareKey", keyId: linkId })]);
    expect(edges[0]).not.toHaveProperty("pending");
    expect(mgr.getEffectiveRole("a")).toBe("use");
  });

  it("confirmShareKeyRedemption re-adds an edge a concurrent revert severed", async () => {
    let { storage, mgr } = makeManager();
    let { key, linkId } = await mgr.createShareLink({ caller: owner, role: "use" });
    await mgr.redeemShareKey({
      rawKey: key, profileId: "a", fetchProfile: async () => profile("a"),
    });

    // A parallel open of the same link failed verification and reverted while this open's
    // verification was succeeding. The successful open's confirm must still land the grant.
    mgr.revertShareKeyRedemption("a", linkId);
    expect(storage.collaborators.get("a")!.addedBy).toEqual([]);

    mgr.confirmShareKeyRedemption("a", linkId);
    expect(storage.collaborators.get("a")!.addedBy)
        .toEqual([expect.objectContaining({ type: "shareKey", keyId: linkId, role: "use" })]);
    expect(mgr.getEffectiveRole("a")).toBe("use");
  });

  it("revertShareKeyRedemption leaves a confirmed edge alone", async () => {
    let { storage, mgr } = makeManager();
    let { key, linkId } = await mgr.createShareLink({ caller: owner, role: "build" });
    await redeemConfirmed(mgr, key, "a");

    // A parallel open of the same link failed verification after this one confirmed; its revert
    // must not take away the grant the successful open established.
    mgr.revertShareKeyRedemption("a", linkId);

    expect(storage.collaborators.get("a")!.addedBy).toHaveLength(1);
    expect(mgr.getEffectiveRole("a")).toBe("build");
  });

  it("a redemption confirmed after its link was revoked grants nothing", async () => {
    let { mgr } = makeManager();
    let { key, linkId } = await mgr.createShareLink({ caller: owner, role: "build" });
    await mgr.redeemShareKey({
      rawKey: key, profileId: "a", fetchProfile: async () => profile("a"),
    });
    mgr.revokeShareLink(owner, linkId, []);

    // Confirming cannot resurrect revoked authority: the confirmed edge is inert.
    mgr.confirmShareKeyRedemption("a", linkId);
    expect(mgr.getEffectiveRole("a")).toBeUndefined();
    expect(ids(mgr.listCollaborators())).toEqual([]);
  });

  it("a pending build edge does not raise the caller's sharing authority", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    let { key } = await mgr.createShareLink({ caller: owner, role: "build" });
    await mgr.redeemShareKey({
      rawKey: key, profileId: "a", fetchProfile: async () => profile("a"),
    });

    // Sharing mutators read the live graph, where the pending edge is invisible: "a" is still
    // only a "use" collaborator and cannot mint build-role grants.
    await expect(mgr.createShareLink({ caller: collab("a"), role: "build" }))
        .rejects.toThrow(/higher than your own/);
  });
});

describe("addCollaborator", () => {
  it("adds a new collaborator with a user edge from the caller", () => {
    let { storage, mgr } = makeManager();
    let info = mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "build", note: "hi" });
    expect(info.addedBy).toEqual([
      expect.objectContaining({ type: "user", sharer: OWNER, role: "build", note: "hi" }),
    ]);
    expect(info.role).toBe("build");
    expect(storage.collaborators.get("a")).toBeDefined();
  });

  it("records the granted role", () => {
    let { mgr } = makeManager();
    let info = mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "use" });
    expect(info.role).toBe("use");
  });

  it("refuses to add the owner", () => {
    let { mgr } = makeManager();
    expect(() => mgr.addCollaborator({ caller: owner, profile: profile(OWNER), role: "build" }))
        .toThrow(/owner/);
  });

  it("forbids granting a role higher than the caller's own", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    expect(() => mgr.addCollaborator({ caller: collab("a"), profile: profile("b"), role: "build" }))
        .toThrow(/higher than your own/);
    // Granting an equal-or-lower role is fine.
    expect(() => mgr.addCollaborator({ caller: collab("a"), profile: profile("b"), role: "use" }))
        .not.toThrow();
  });

  it("adds a second edge from a different sharer but dedups same sharer", () => {
    let { storage, mgr } = makeManager();
    mgr.addCollaborator({ caller: owner, profile: profile("b"), role: "build" });
    mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "build" });
    mgr.addCollaborator({ caller: collab("b"), profile: profile("a"), role: "build" });
    mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "build" });  // dup sharer
    expect(storage.collaborators.get("a")!.addedBy).toHaveLength(2);
  });

  it("upgrades (never downgrades) the role of an existing same-sharer edge", () => {
    let { storage, mgr } = makeManager();
    mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "use" });
    mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "build" });
    expect(storage.collaborators.get("a")!.addedBy).toHaveLength(1);
    expect(mgr.getEffectiveRole("a")).toBe("build");

    // A subsequent lower grant does not downgrade the existing edge.
    mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "use" });
    expect(mgr.getEffectiveRole("a")).toBe("build");
  });
});

describe("computeEffectiveRoles", () => {
  it("propagates roles along a chain", () => {
    let { storage, mgr } = makeManager();
    // owner -> a -> b
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge("a", "build")]);
    let roles = mgr.computeEffectiveRoles();
    expect(roles.get("a")).toBe("build");
    expect(roles.get("b")).toBe("build");
  });

  it("bounds a granted role by the sharer's effective role", () => {
    let { storage, mgr } = makeManager();
    // owner -grants use-> a; a -grants build-> b. b is bounded by a's "use".
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    seedCollaborator(storage, "b", [userEdge("a", "build")]);
    expect(mgr.getEffectiveRole("b")).toBe("use");
  });

  it("takes the maximum across multiple paths", () => {
    let { storage, mgr } = makeManager();
    // b is reachable via owner directly (use) and via a (build).
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "use"), userEdge("a", "build")]);
    expect(mgr.getEffectiveRole("b")).toBe("build");
  });

  it("excludes a removed user and drops their sole dependents", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "b", [userEdge("a")]);
    let roles = mgr.computeEffectiveRoles({ removedUser: "a" });
    expect(roles.has("a")).toBe(false);
    expect(roles.has("b")).toBe(false);
  });

  it("cascades share-link revocation through dependent users", () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", OWNER);
    seedCollaborator(storage, "a", [keyEdge("k1")]);
    seedCollaborator(storage, "b", [userEdge("a")]);
    let roles = mgr.computeEffectiveRoles({ revokedLinkId: "k1" });
    expect(roles.has("a")).toBe(false);
    expect(roles.has("b")).toBe(false);
  });
});

describe("previewRemoveCollaborator", () => {
  it("reports a transitively-removed dependent", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "b", [userEdge("a")]);
    let affected = mgr.previewRemoveCollaborator(owner, "a");
    expect(ids(affected)).toEqual(["a", "b"]);
    expect(affected.find(x => x.profile.id === "b")!.newRole).toBe(null);
  });

  it("reports a downgrade rather than a removal", () => {
    let { storage, mgr } = makeManager();
    // b has build via a, but also use directly from the owner. Removing a downgrades b to use.
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "use"), userEdge("a", "build")]);
    let affected = mgr.previewRemoveCollaborator(owner, "a");
    let b = affected.find(x => x.profile.id === "b")!;
    expect(b.oldRole).toBe("build");
    expect(b.newRole).toBe("use");
  });
});

describe("removeCollaborator", () => {
  it("severs the target's access and lets dependents go dark, but retains records", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "b", [userEdge("a")]);

    let affected = mgr.removeCollaborator(owner, "a", []);
    expect(ids(affected)).toEqual(["a", "b"]);
    // Records are NOT deleted under the lazy model.
    expect(storage.collaborators.get("a")).toBeDefined();
    expect(storage.collaborators.get("b")).toBeDefined();
    // But neither has access anymore.
    expect(mgr.getEffectiveRole("a")).toBeUndefined();
    expect(mgr.getEffectiveRole("b")).toBeUndefined();
  });

  it("owner severs ALL incoming edges to the target", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    // t is reachable via both the owner and a.
    seedCollaborator(storage, "t", [userEdge(OWNER), userEdge("a")]);

    mgr.removeCollaborator(owner, "t", []);
    expect(storage.collaborators.get("t")!.addedBy).toEqual([]);
    expect(mgr.getEffectiveRole("t")).toBeUndefined();
  });

  it("re-adding a removed intermediary restores their downstream shares (undo)", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    // a has shared with five users.
    for (let i = 0; i < 5; i++) seedCollaborator(storage, `d${i}`, [userEdge("a")]);

    mgr.removeCollaborator(owner, "a", []);
    expect(mgr.getEffectiveRole("a")).toBeUndefined();
    for (let i = 0; i < 5; i++) expect(mgr.getEffectiveRole(`d${i}`)).toBeUndefined();

    // Undo by re-adding a; the five downstream grants were never deleted.
    mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "build" });
    expect(mgr.getEffectiveRole("a")).toBe("build");
    for (let i = 0; i < 5; i++) expect(mgr.getEffectiveRole(`d${i}`)).toBe("build");
  });

  it("re-roots a kept dependent under the caller", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "b", [userEdge("a")]);

    let affected = mgr.removeCollaborator(owner, "a", ["b"]);
    expect(ids(affected)).toEqual(["a"]);  // b is kept, so not reported
    expect(mgr.getEffectiveRole("b")).toBe("build");
    // b gained a fresh edge from the caller.
    expect(storage.collaborators.get("b")!.addedBy)
        .toContainEqual(expect.objectContaining({ type: "user", sharer: OWNER, role: "build" }));
  });

  it("keeps a downgraded user at their prior role when kept", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "use"), userEdge("a", "build")]);

    let affected = mgr.removeCollaborator(owner, "a", ["b"]);
    expect(ids(affected)).toEqual(["a"]);
    expect(mgr.getEffectiveRole("b")).toBe("build");
  });

  it("downgrades a non-kept user instead of removing them", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "use"), userEdge("a", "build")]);

    let affected = mgr.removeCollaborator(owner, "a", []);
    expect(affected.map(x => x.profile.id).toSorted()).toEqual(["a", "b"]);
    expect(affected.find(x => x.profile.id === "b")!.newRole).toBe("use");
    // b retains access at the lower role; its (now-inert) edge from a is left untouched (lazy).
    expect(mgr.getEffectiveRole("b")).toBe("use");
    expect(storage.collaborators.get("b")!.addedBy).toHaveLength(2);
  });

  it("does not prune now-inert edges from surviving collaborators (lazy)", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    // c is supported by the owner directly, but also carries an edge from a.
    seedCollaborator(storage, "c", [userEdge(OWNER), userEdge("a")]);

    mgr.removeCollaborator(owner, "a", []);
    // c keeps full access; the inert edge from a remains in storage.
    expect(mgr.getEffectiveRole("c")).toBe("build");
    expect(storage.collaborators.get("c")!.addedBy).toHaveLength(2);
  });

  it("lets a non-owner remove only their own edge, sparing the target if others remain", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "t", [userEdge(OWNER), userEdge("a")]);

    let affected = mgr.removeCollaborator(collab("a"), "t", []);
    expect(affected).toEqual([]);
    expect(storage.collaborators.get("t")!.addedBy)
        .toEqual([expect.objectContaining({ type: "user", sharer: OWNER })]);
  });

  it("forbids a non-owner from removing a user they didn't add", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "t", [userEdge(OWNER)]);
    expect(() => mgr.removeCollaborator(collab("a"), "t", [])).toThrow(/only remove users/);
  });

  it("throws when the target is not a collaborator", () => {
    let { mgr } = makeManager();
    expect(() => mgr.removeCollaborator(owner, "ghost", [])).toThrow(/not a collaborator/);
  });
});

describe("revokeShareLink", () => {
  it("soft-revokes the link and cuts off users supported only by it", () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", OWNER);
    seedCollaborator(storage, "a", [keyEdge("k1")]);
    seedCollaborator(storage, "b", [userEdge("a")]);

    let affected = mgr.revokeShareLink(owner, "k1", []);
    expect(ids(affected)).toEqual(["a", "b"]);
    // The link record is retained but marked revoked.
    expect(link(storage, "k1").revoked).toBe(true);
    expect(mgr.getEffectiveRole("a")).toBeUndefined();
    expect(mgr.getEffectiveRole("b")).toBeUndefined();
  });

  it("does not cascade-revoke links created by cut-off users (lazy)", () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", OWNER);
    seedCollaborator(storage, "a", [keyEdge("k1")]);
    seedLink(storage, "k2", "a");  // link created by a
    seedCollaborator(storage, "b", [keyEdge("k2")]);

    mgr.revokeShareLink(owner, "k1", []);
    // k2 is left untouched, but b is unreachable because a (k2's creator) is unreachable.
    expect(link(storage, "k2").revoked).toBeFalsy();
    expect(mgr.getEffectiveRole("b")).toBeUndefined();

    // Undo: re-add a, and b regains access through k2.
    mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "build" });
    expect(mgr.getEffectiveRole("b")).toBe("build");
  });

  it("a revoked link's keys can no longer be redeemed", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareLink({ caller: owner, role: "build" });
    let linkId = mgr.listShareLinkRecords()[0].id;

    mgr.revokeShareLink(owner, linkId, []);

    await redeemConfirmed(mgr, key, "a");
    expect(storage.collaborators.get("a")).toBeUndefined();
  });

  it("forbids a non-owner from revoking a link they didn't create", () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", OWNER);
    expect(() => mgr.revokeShareLink(collab("a"), "k1", [])).toThrow(/only revoke/);
  });
});

describe("createShareLink", () => {
  it("persists the granted role", async () => {
    let { mgr } = makeManager();
    let { key, linkId } = await mgr.createShareLink({ caller: owner, role: "use" });
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    let records = mgr.listShareLinkRecords();
    expect(records).toHaveLength(1);
    expect(records[0].role).toBe("use");
    // The caller is told which link it created, so it never has to infer it from the list.
    expect(linkId).toBe(records[0].id);
  });

  it("forbids creating a link with a higher role than the caller's own", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    expect(() => mgr.createShareLink({ caller: collab("a"), role: "build" }))
        .rejects.toThrow(/higher than your own/);
  });

  it("a throwing assertGrantAllowed aborts with nothing persisted", async () => {
    let { storage, mgr } = makeManager();
    await expect(mgr.createShareLink({
      caller: owner, role: "build",
      assertGrantAllowed: () => { throw new Error("sharing is closed"); },
    })).rejects.toThrow(/sharing is closed/);
    // The minted key was discarded, never stored.
    expect([...storage.shareKeys.list()]).toEqual([]);
  });

  it("invokes assertGrantAllowed once and persists the grant when it passes", async () => {
    let { mgr } = makeManager();
    let calls = 0;
    let { linkId } = await mgr.createShareLink({
      caller: owner, role: "use", assertGrantAllowed: () => { calls++; },
    });
    expect(calls).toBe(1);
    expect(mgr.listShareLinkRecords().map(r => r.id)).toEqual([linkId]);
  });
});

describe("newShareLinkKey", () => {
  it("mints a new key for the same link that redeems to one grant", async () => {
    let { storage, mgr } = makeManager();
    let { key: key1 } = await mgr.createShareLink({ caller: owner, role: "use", note: "team" });
    let linkId = mgr.listShareLinkRecords()[0].id;

    let { key: key2 } = await mgr.newShareLinkKey({ caller: owner, linkId });
    expect(key2).not.toBe(key1);

    // Two secret records, one logical link: listing still shows a single entry, and the new
    // secret inherits the link's note/role.
    expect([...storage.shareKeys.list()]).toHaveLength(2);
    let listed = mgr.listShareLinkRecords();
    expect(listed).toHaveLength(1);
    expect(listed[0].role).toBe("use");
    expect(listed[0].note).toBe("team");

    // Both secrets redeem, and a user redeeming both gets a single (deduplicated) edge.
    await redeemConfirmed(mgr, key1, "a");
    await redeemConfirmed(mgr, key2, "a");
    expect(storage.collaborators.get("a")!.addedBy).toHaveLength(1);
    expect(mgr.getEffectiveRole("a")).toBe("use");
  });

  it("revoking a link revokes every key minted for it", async () => {
    let { storage, mgr } = makeManager();
    let { key: key1 } = await mgr.createShareLink({ caller: owner, role: "build" });
    let linkId = mgr.listShareLinkRecords()[0].id;
    let { key: key2 } = await mgr.newShareLinkKey({ caller: owner, linkId });

    mgr.revokeShareLink(owner, linkId, []);
    expect(link(storage, linkId).revoked).toBe(true);
    // The copies are reclaimed; the link row stays, since edges point at it.
    expect([...storage.shareKeys.list()].map(r => r.id)).toEqual([linkId]);

    // Neither the original nor the copied secret can be redeemed anymore.
    for (let rawKey of [key1, key2]) {
      await redeemConfirmed(mgr, rawKey, "a");
    }
    expect(storage.collaborators.get("a")).toBeUndefined();
  });

  it("forbids a non-owner from copying a link they didn't create", () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", OWNER);
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    expect(mgr.newShareLinkKey({ caller: collab("a"), linkId: "k1" }))
        .rejects.toThrow(/only copy/);
  });

  it("forbids copying a link that now grants a higher role than the caller's own", () => {
    let { storage, mgr } = makeManager();
    // "a" created a build link, then was downgraded to use.
    seedLink(storage, "k1", "a", "build");
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    expect(mgr.newShareLinkKey({ caller: collab("a"), linkId: "k1" }))
        .rejects.toThrow(/higher than your own/);
  });

  it("a throwing assertGrantAllowed aborts the copy with nothing persisted", async () => {
    let { storage, mgr } = makeManager();
    let { linkId } = await mgr.createShareLink({ caller: owner, role: "build" });

    await expect(mgr.newShareLinkKey({
      caller: owner, linkId,
      assertGrantAllowed: () => { throw new Error("sharing is closed"); },
    })).rejects.toThrow(/sharing is closed/);
    // Only the original link record remains; the aborted copy's key was never stored.
    expect([...storage.shareKeys.list()].map(r => r.id)).toEqual([linkId]);

    let calls = 0;
    await mgr.newShareLinkKey({ caller: owner, linkId, assertGrantAllowed: () => { calls++; } });
    expect(calls).toBe(1);
    expect([...storage.shareKeys.list()]).toHaveLength(2);
  });

  it("cannot manage a link through the id of one of its copies", async () => {
    let { storage, mgr } = makeManager();
    await mgr.createShareLink({ caller: owner, role: "build" });
    let linkId = mgr.listShareLinkRecords()[0].id;
    await mgr.newShareLinkKey({ caller: owner, linkId });

    // A copy has its own hash in the same table. Mistaking one for a link would make revocation a
    // silent no-op: redemption resolves the copy through to the link, which would go untouched.
    let aliasId = [...storage.shareKeys.list()].find(r => r.alias !== undefined)!.id;
    expect(mgr.listShareLinkRecords().map(r => r.id)).toEqual([linkId]);
    expect(mgr.newShareLinkKey({ caller: owner, linkId: aliasId })).rejects.toThrow(/not found/);
    expect(() => mgr.updateShareLink(owner, aliasId, "x")).toThrow(/not found/);
    expect(() => mgr.revokeShareLink(owner, aliasId, [])).toThrow(/not found/);
  });

});

describe("pre-copy share keys", () => {
  it("reads a key written before link copies existed as a link", async () => {
    let { storage, mgr } = makeManager();
    // A key written before copies existed already has the shape of a link, and its edges already
    // point at the hash, so it reads back as a link with no migration.
    storage.shareKeys.put({
      id: "hash1", note: "team", created: new Date("2025-01-01"), createdBy: OWNER, role: "use",
    });
    seedCollaborator(storage, "a", [keyEdge("hash1", "use")]);

    expect(mgr.listShareLinkRecords()).toMatchObject(
        [{ id: "hash1", note: "team", createdBy: OWNER, role: "use" }]);
    expect(mgr.getEffectiveRole("a")).toBe("use");

    // Such a link can also be copied, and the copy grants the same access.
    let { key } = await mgr.newShareLinkKey({ caller: owner, linkId: "hash1" });
    await redeemConfirmed(mgr, key, "b");
    expect(mgr.getEffectiveRole("b")).toBe("use");
  });
});

describe("listCollaborators", () => {
  it("includes each collaborator's effective role", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "use")]);
    let list = mgr.listCollaborators();
    expect(list.find(x => x.profile.id === "a")!.role).toBe("build");
    expect(list.find(x => x.profile.id === "b")!.role).toBe("use");
  });

  it("omits collaborators who linger in storage but are unreachable", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "dead", []);  // record with no incoming edges
    let list = mgr.listCollaborators();
    expect(ids(list)).toEqual(["a"]);
  });
});

describe("listShareLinkRecords", () => {
  it("omits revoked links", () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", OWNER);
    storage.shareKeys.put({ id: "k2", created: new Date(), createdBy: OWNER, revoked: true });
    expect(mgr.listShareLinkRecords().map(r => r.id)).toEqual(["k1"]);
  });
});

describe("updateShareLink", () => {
  it("owner can edit any link's note", () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", "a");
    mgr.updateShareLink(owner, "k1", "renamed");
    expect(link(storage, "k1").note).toBe("renamed");
  });

  it("non-owner cannot edit a link they didn't create", () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", OWNER);
    expect(() => mgr.updateShareLink(collab("a"), "k1", "x")).toThrow(/only edit/);
  });
});
