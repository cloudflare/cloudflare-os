import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { PROPERTY_RUN_OPTIONS } from "@gadgets/scripts/property-runs";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import { SharingManager, SharingStorage } from "../src/sharing.js";
import type { CollaboratorRecord, ShareKeyRecord } from "../src/storage-schema/overseer-storage.js";
import {
  AffectedCollaborator, AiChatAuthorInfo, PermissionEdge, CollaboratorRole, getOpenWorkspaceErrorCode,
  OPEN_WORKSPACE_ERROR_CODES,
} from "@gadgets/workshop-shared/api";
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

function makeManager(ownerInvitesOnly: () => boolean = () => false)
    : { storage: SharingStorage; mgr: SharingManager } {
  let storage = makeStorage();
  return { storage, mgr: new SharingManager(storage, OWNER, ownerInvitesOnly) };
}

// A manager whose `ownerInvitesOnly` flag the test can flip at any point.
function makeManagerWithFlag() {
  let flags = { ownerInvitesOnly: false };
  return { flags, ...makeManager(() => flags.ownerInvitesOnly) };
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

    await mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => profile("a"),
    });

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

    await mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => profile("a"),
    });
    await mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => profile("a"),
    });

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

    await mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => profile("a"),
    });
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

  it("forbids creating a link with a higher role than the caller's own", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    await expect(mgr.createShareLink({ caller: collab("a"), role: "build" }))
        .rejects.toThrow(/higher than your own/);
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
    await mgr.redeemShareKey({ rawKey: key1, profileId: "a", fetchProfile: async () => profile("a") });
    await mgr.redeemShareKey({ rawKey: key2, profileId: "a", fetchProfile: async () => profile("a") });
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
      await mgr.redeemShareKey({ rawKey, profileId: "a", fetchProfile: async () => profile("a") });
    }
    expect(storage.collaborators.get("a")).toBeUndefined();
  });

  it("forbids a non-owner from copying a link they didn't create", async () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", OWNER);
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    await expect(mgr.newShareLinkKey({ caller: collab("a"), linkId: "k1" }))
        .rejects.toThrow(/only copy/);
  });

  it("forbids copying a link that now grants a higher role than the caller's own", async () => {
    let { storage, mgr } = makeManager();
    // "a" created a build link, then was downgraded to use.
    seedLink(storage, "k1", "a", "build");
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    await expect(mgr.newShareLinkKey({ caller: collab("a"), linkId: "k1" }))
        .rejects.toThrow(/higher than your own/);
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
    await expect(mgr.newShareLinkKey({ caller: owner, linkId: aliasId })).rejects.toThrow(/not found/);
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
    await mgr.redeemShareKey(
        { rawKey: key, profileId: "b", fetchProfile: async () => profile("b") });
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

describe("ownerInvitesOnly", () => {
  it("refuses to create or copy share links", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedLink(storage, "k1", OWNER);
    flags.ownerInvitesOnly = true;

    await expect(mgr.createShareLink({ caller: owner, role: "use" }))
        .rejects.toThrow(/Share links are disabled/);
    await expect(mgr.newShareLinkKey({ caller: owner, linkId: "k1" }))
        .rejects.toThrow(/Share links are disabled/);
    expect([...storage.shareKeys.list()].map(r => r.id)).toEqual(["k1"]);

    // Link management isn't an open() failure, so it carries no open-workspace code.
    let error = await mgr.createShareLink({ caller: owner, role: "use" }).catch(e => e);
    expect(getOpenWorkspaceErrorCode(error)).toBeUndefined();
  });

  it("persists nothing when the flag flips while a key is being minted", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedLink(storage, "k1", OWNER);

    // Both calls park in #mintKey's await, and check the flag only once it resolves.
    let created = mgr.createShareLink({ caller: owner, role: "use" });
    let copied = mgr.newShareLinkKey({ caller: owner, linkId: "k1" });
    flags.ownerInvitesOnly = true;

    await expect(created).rejects.toThrow(/Share links are disabled/);
    await expect(copied).rejects.toThrow(/Share links are disabled/);
    expect([...storage.shareKeys.list()].map(r => r.id)).toEqual(["k1"]);
  });

  it("refuses a new user redeeming a link created before ownerInvitesOnly", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    let { key } = await mgr.createShareLink({ caller: owner, role: "build" });
    flags.ownerInvitesOnly = true;

    let fetched = 0;
    await expect(mgr.redeemShareKey({
      rawKey: key, profileId: "newbie",
      fetchProfile: async () => { fetched++; return profile("newbie"); },
    })).rejects.toMatchObject({
      code: OPEN_WORKSPACE_ERROR_CODES.shareLinksDisabled,
      message: expect.stringMatching(/Share links are disabled/),
    });

    // Refused before the profile RPC.
    expect(fetched).toBe(0);
    expect(storage.collaborators.get("newbie")).toBeUndefined();
  });

  it("persists nothing when the flag flips during the profile fetch", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    let { key } = await mgr.createShareLink({ caller: owner, role: "build" });

    await expect(mgr.redeemShareKey({
      rawKey: key, profileId: "newbie",
      fetchProfile: async () => { flags.ownerInvitesOnly = true; return profile("newbie"); },
    })).rejects.toMatchObject({ code: OPEN_WORKSPACE_ERROR_CODES.shareLinksDisabled });
    expect(storage.collaborators.get("newbie")).toBeUndefined();
  });

  it("lets a direct collaborator reopen a link without adding an edge", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    let { key } = await mgr.createShareLink({ caller: owner, role: "build" });
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    flags.ownerInvitesOnly = true;

    await mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => profile("a"),
    });

    // No new grant: still just the owner's edge, at its original role.
    expect(storage.collaborators.get("a")!.addedBy).toEqual([
      expect.objectContaining({ type: "user", sharer: OWNER }),
    ]);
    expect(mgr.getEffectiveRole("a")).toBe("use");
  });

  it("refuses an existing collaborator the owner did not add directly", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    let { key, linkId } = await mgr.createShareLink({ caller: owner, role: "build" });
    seedCollaborator(storage, "a", [keyEdge(linkId)]);
    flags.ownerInvitesOnly = true;

    await expect(mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => profile("a"),
    })).rejects.toMatchObject({ code: OPEN_WORKSPACE_ERROR_CODES.shareLinksDisabled });
    expect(storage.collaborators.get("a")!.addedBy).toEqual([
      expect.objectContaining({ type: "shareKey", keyId: linkId }),
    ]);
  });

  it("still ignores an unknown key", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    flags.ownerInvitesOnly = true;
    await mgr.redeemShareKey({
      rawKey: "00112233445566778899aabbccddeeff", profileId: "a",
      fetchProfile: async () => profile("a"),
    });
    expect(storage.collaborators.get("a")).toBeUndefined();
  });

  it("lets only the owner add collaborators", () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    flags.ownerInvitesOnly = true;

    expect(() => mgr.addCollaborator({ caller: collab("a"), profile: profile("b"), role: "use" }))
        .toThrow(/Only the workspace owner/);
    expect(storage.collaborators.get("b")).toBeUndefined();

    mgr.addCollaborator({ caller: owner, profile: profile("b"), role: "use" });
    expect(mgr.getEffectiveRole("b")).toBe("use");
  });

  it("keeps link management available to the owner", () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedLink(storage, "k1", OWNER);
    seedCollaborator(storage, "a", [keyEdge("k1"), userEdge(OWNER, "use")]);
    flags.ownerInvitesOnly = true;

    expect(mgr.listShareLinkRecords().map(r => r.id)).toEqual(["k1"]);
    mgr.updateShareLink(owner, "k1", "renamed");
    // The link already grants nothing, so revoking it changes nobody's access.
    expect(mgr.revokeShareLink(owner, "k1", [])).toEqual([]);
    expect(mgr.getEffectiveRole("a")).toBe("use");
    expect(ids(mgr.removeCollaborator(owner, "a", []))).toEqual(["a"]);
  });

  it("counts only direct owner grants", () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedLink(storage, "k1", OWNER);
    seedCollaborator(storage, "direct", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "linked", [keyEdge("k1")]);
    seedCollaborator(storage, "transitive", [userEdge("direct", "build")]);
    let baseline = mgr.computeEffectiveRoles();
    expect(ids(mgr.listCollaborators())).toEqual(["direct", "linked", "transitive"]);

    flags.ownerInvitesOnly = true;

    expect(mgr.getEffectiveRole("direct")).toBe("build");
    expect(mgr.getEffectiveRole("linked")).toBeUndefined();
    expect(mgr.getEffectiveRole("transitive")).toBeUndefined();
    expect(ids(mgr.listCollaborators())).toEqual(["direct"]);
    expect(mgr.computeAffectedByOwnerInvitesOnly(baseline)).toEqual([
      expect.objectContaining({ profile: profile("linked"), oldRole: "build", newRole: null }),
      expect.objectContaining({ profile: profile("transitive"), oldRole: "build", newRole: null }),
    ]);
  });

  it("counts a user the owner kept during a removal as direct", () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge("a", "use")]);

    // Removing a while keeping b re-roots b on an edge from the owner.
    mgr.removeCollaborator(owner, "a", ["b"]);
    flags.ownerInvitesOnly = true;

    expect(mgr.getEffectiveRole("b")).toBe("use");
  });

  it("downgrades a collaborator to their owner edge's role", () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "use"), userEdge("a", "build")]);
    let baseline = mgr.computeEffectiveRoles();
    expect(baseline.get("b")).toBe("build");

    flags.ownerInvitesOnly = true;

    expect(mgr.getEffectiveRole("b")).toBe("use");
    expect(mgr.computeAffectedByOwnerInvitesOnly(baseline)).toEqual([
      expect.objectContaining({ profile: profile("b"), oldRole: "build", newRole: "use" }),
    ]);
  });

  it("re-adding an intermediary restores nobody else", () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge("a", "use")]);

    mgr.removeCollaborator(owner, "a", []);
    expect(mgr.getEffectiveRole("b")).toBeUndefined();
    flags.ownerInvitesOnly = true;

    // Without the flag, re-adding a would bring b back through a's untouched edge. Once it is set,
    // only the owner's direct grants count, so b stays out until the owner adds them directly.
    mgr.addCollaborator({ caller: owner, profile: profile("a"), role: "build" });
    expect(mgr.getEffectiveRole("a")).toBe("build");
    expect(mgr.getEffectiveRole("b")).toBeUndefined();

    mgr.addCollaborator({ caller: owner, profile: profile("b"), role: "use" });
    expect(mgr.getEffectiveRole("b")).toBe("use");
  });
});

// ---------------------------------------------------------------------------------------------
// Property: the sharing graph under the actions the Share dialog offers. fast-check generates a
// sequence of steps by the owner and four other people -- invite someone by name, create a share
// link, copy it, open a link, revoke a link, remove someone -- and replays it against a
// SharingManager. Removal and revocation go through the dialog's flow: preview, then confirm with
// some of the previewed people kept. After every step each person's access is checked against a
// model.
//
// The model keeps only the grants: who invited whom at which role (a repeat invite from the same
// person keeps the higher role), which links each person opened, and which links are revoked.
// Access is reachability from the owner, the rule the module documents: "build" if some path from
// the owner grants "build" on every edge, "use" if any path reaches the person, otherwise nothing.
// A link's edges start at its creator. Removal and revocation never touch other people's grants;
// downstream people just stop being reachable, and come back when a path does. Keeping someone
// gives them a fresh grant from the actor at the role they had.
//
// Steps only take actions the Workshop offers the acting person: only someone with "build" can
// share (a "use" session is refused every sharing call), so someone who lost access cannot act at
// all; a collaborator removes only people they invited and revokes or copies only links they
// created; and the dialog lists only people who currently have access and live links. Anyone may
// open any link they were sent, live or revoked, with or without access.
// Scenarios a seed might miss are pinned as `examples`.

const PEOPLE = [OWNER, "ana", "ben", "cy", "dot"];

// `person` and `target` are indices into PEOPLE (0 is the owner). Every other number picks, modulo
// the count, from what is on offer when the step runs: `actor` among the people who can share
// (the owner, then the rest in PEOPLE order); `choice` among the dialog's (actor, link) or (actor,
// person) pairs, by actor and then by link creation or PEOPLE order; `link` and `key` among every
// link created so far and that link's keys. `keep` is a bitmask over PEOPLE indices choosing which
// previewed people to keep.
type Step =
  | { kind: "invite"; actor: number; target: number; role: CollaboratorRole }
  | { kind: "createLink"; actor: number; role: CollaboratorRole }
  | { kind: "copyLink"; choice: number }
  | { kind: "open"; person: number; link: number; key: number }
  | { kind: "revoke"; choice: number; keep: number }
  | { kind: "remove"; choice: number; keep: number };

type ModelLink = { id: string; creator: string; role: CollaboratorRole; revoked: boolean; keys: string[] };

class SharingModel {
  /** target -> inviter -> the highest role that inviter granted them. */
  invites = new Map<string, Map<string, CollaboratorRole>>();
  /** person -> ids of the links they opened. */
  opened = new Map<string, Set<string>>();
  links: ModelLink[] = [];

  invite(target: string, inviter: string, role: CollaboratorRole) {
    let inviters = this.invites.get(target) ?? new Map<string, CollaboratorRole>();
    inviters.set(inviter, inviters.get(inviter) === "build" ? "build" : role);
    this.invites.set(target, inviters);
  }

  open(person: string, linkId: string) {
    this.opened.set(person, (this.opened.get(person) ?? new Set()).add(linkId));
  }

  /** Everyone but the owner who has access, with their role. */
  roles(): Map<string, CollaboratorRole> {
    let edges: { from: string; to: string; role: CollaboratorRole }[] = [];
    for (let [to, inviters] of this.invites) {
      for (let [from, role] of inviters) edges.push({ from, to, role });
    }
    for (let [to, linkIds] of this.opened) {
      for (let shareLink of this.links) {
        if (linkIds.has(shareLink.id) && !shareLink.revoked) {
          edges.push({ from: shareLink.creator, to, role: shareLink.role });
        }
      }
    }
    let reachable = (usable: (role: CollaboratorRole) => boolean) => {
      let seen = new Set([OWNER]);
      for (let grew = true; grew;) {
        grew = false;
        for (let edge of edges) {
          if (usable(edge.role) && seen.has(edge.from) && !seen.has(edge.to)) {
            seen.add(edge.to);
            grew = true;
          }
        }
      }
      seen.delete(OWNER);
      return seen;
    };
    let viaBuild = reachable(role => role === "build");
    let roles = new Map<string, CollaboratorRole>();
    for (let id of reachable(() => true)) roles.set(id, viaBuild.has(id) ? "build" : "use");
    return roles;
  }

  role(id: string): CollaboratorRole | undefined {
    return id === OWNER ? "build" : this.roles().get(id);
  }
}

type Change = { id: string; oldRole: CollaboratorRole; newRole: CollaboratorRole | null };

// The people who lost access or dropped to "use" going from `before` to `after`. (None of these
// steps raises anyone.)
function changes(before: Map<string, CollaboratorRole>, after: Map<string, CollaboratorRole>): Change[] {
  let result: Change[] = [];
  for (let [id, oldRole] of before) {
    let newRole = after.get(id) ?? null;
    if (newRole !== oldRole) result.push({ id, oldRole, newRole });
  }
  return result.toSorted((a, b) => a.id.localeCompare(b.id));
}

function reported(list: AffectedCollaborator[]): Change[] {
  return list.map(x => ({ id: x.profile.id, oldRole: x.oldRole, newRole: x.newRole }))
      .toSorted((a, b) => a.id.localeCompare(b.id));
}

function caller(id: string) {
  return { profileId: id, isOwner: id === OWNER };
}

function pick<T>(list: T[], index: number): T | undefined {
  return list.length === 0 ? undefined : list[index % list.length];
}

async function replaySharing(steps: Step[]) {
  let { mgr } = makeManager();
  let model = new SharingModel();
  let sharers = () => PEOPLE.filter(id => model.role(id) === "build");
  // The live links each sharer may revoke or copy: any, for the owner; their own, for anyone else.
  let linkActions = () => sharers().flatMap(actor => model.links
      .filter(shareLink => !shareLink.revoked && (actor === OWNER || shareLink.creator === actor))
      .map(shareLink => ({ actor, shareLink })));
  // The people each sharer may remove: anyone with access, for the owner; people they invited who
  // still have access, for anyone else.
  let removals = () => {
    let roles = model.roles();
    return sharers().flatMap(actor => PEOPLE
        .filter(target => roles.has(target) && target !== actor
            && (actor === OWNER || model.invites.get(target)?.has(actor)))
        .map(target => ({ actor, target })));
  };

  // Confirm a previewed removal or revocation, keeping the previewed people `keep` selects (never
  // the person being removed, whom the dialog does not offer). The preview must name exactly who
  // the model says loses or drops; the confirmation, the same minus whoever the kept people's fresh
  // grants restore.
  let confirm = (opts: {
    label: string; actor: string; keep: number; before: Map<string, CollaboratorRole>;
    preview: Change[]; target?: string; commit: (keepUsers: string[]) => Change[];
  }) => {
    expect(opts.preview, `${opts.label}: preview`).toEqual(changes(opts.before, model.roles()));
    let keepUsers = opts.preview.map(x => x.id)
        .filter(id => id !== opts.target && (opts.keep & (1 << PEOPLE.indexOf(id))) !== 0);
    let actual = opts.commit(keepUsers);
    for (let id of keepUsers) model.invite(id, opts.actor, opts.before.get(id)!);
    expect(actual, `${opts.label} keeping [${keepUsers.join(", ")}]: people reported as losing access`)
        .toEqual(changes(opts.before, model.roles()));
  };

  for (let [index, step] of steps.entries()) {
    let label = `step ${index}`;
    switch (step.kind) {
      case "invite": {
        let actor = pick(sharers(), step.actor)!, target = PEOPLE[step.target];
        if (actor === target) break;
        label += `: ${actor} invites ${target} as ${step.role}`;
        let info = mgr.addCollaborator({ caller: caller(actor), profile: profile(target), role: step.role });
        model.invite(target, actor, step.role);
        expect(info.role, `${label}: role reported for ${target}`).toBe(model.role(target));
        break;
      }
      case "createLink": {
        let actor = pick(sharers(), step.actor)!;
        label += `: ${actor} creates link ${model.links.length} for ${step.role}`;
        let { key, linkId } = await mgr.createShareLink({ caller: caller(actor), role: step.role });
        model.links.push({ id: linkId, creator: actor, role: step.role, revoked: false, keys: [key] });
        break;
      }
      case "copyLink": {
        let chosen = pick(linkActions(), step.choice);
        if (!chosen) break;
        let { actor, shareLink } = chosen;
        label += `: ${actor} copies link ${model.links.indexOf(shareLink)}`;
        let { key } = await mgr.newShareLinkKey({ caller: caller(actor), linkId: shareLink.id });
        shareLink.keys.push(key);
        break;
      }
      case "open": {
        let person = PEOPLE[step.person], shareLink = pick(model.links, step.link);
        if (!shareLink) break;
        let keyIndex = step.key % shareLink.keys.length;
        label += `: ${person} opens link ${model.links.indexOf(shareLink)} with key ${keyIndex}`;
        await mgr.redeemShareKey({
          rawKey: shareLink.keys[keyIndex],
          profileId: person,
          fetchProfile: async () => profile(person),
        });
        if (!shareLink.revoked) model.open(person, shareLink.id);
        break;
      }
      case "revoke": {
        let chosen = pick(linkActions(), step.choice);
        if (!chosen) break;
        let { actor, shareLink } = chosen;
        label += `: ${actor} revokes link ${model.links.indexOf(shareLink)}`;
        let before = model.roles();
        let preview = reported(mgr.previewRevokeShareLink(caller(actor), shareLink.id));
        shareLink.revoked = true;
        confirm({
          label, actor, keep: step.keep, before, preview,
          commit: keepUsers => reported(mgr.revokeShareLink(caller(actor), shareLink.id, keepUsers)),
        });
        break;
      }
      case "remove": {
        let chosen = pick(removals(), step.choice);
        if (!chosen) break;
        let { actor, target } = chosen;
        label += `: ${actor} removes ${target}`;
        let before = model.roles();
        let preview = reported(mgr.previewRemoveCollaborator(caller(actor), target));
        // The owner cuts every grant the target holds; anyone else, only their own invite.
        if (actor === OWNER) {
          model.invites.delete(target);
          model.opened.delete(target);
        } else {
          model.invites.get(target)!.delete(actor);
        }
        confirm({
          label, actor, keep: step.keep, before, preview, target,
          commit: keepUsers => reported(mgr.removeCollaborator(caller(actor), target, keepUsers)),
        });
        break;
      }
    }

    let expected = model.roles();
    for (let id of PEOPLE.slice(1)) {
      expect(mgr.getEffectiveRole(id), `${label}: ${id}'s access`).toBe(expected.get(id));
    }
    expect(Object.fromEntries(mgr.listCollaborators().map(c => [c.profile.id, c.role])),
        `${label}: people with access`).toEqual(Object.fromEntries(expected));
    expect(mgr.listShareLinkRecords().map(l => l.id).toSorted(), `${label}: live links`)
        .toEqual(model.links.filter(l => !l.revoked).map(l => l.id).toSorted());
  }
}

describe("sharing graph property", () => {
  const role = fc.constantFrom<CollaboratorRole>("build", "use");
  const person = fc.integer({ min: 1, max: 4 });
  const choice = fc.nat({ max: 15 });
  const keep = fc.nat({ max: (1 << PEOPLE.length) - 1 });
  // Grants outweigh removals, so people often hold several paths when one is cut.
  const step: fc.Arbitrary<Step> = fc.oneof(
    { arbitrary: fc.record({ kind: fc.constant("invite" as const), actor: choice, target: person, role }), weight: 4 },
    { arbitrary: fc.record({ kind: fc.constant("createLink" as const), actor: choice, role }), weight: 2 },
    { arbitrary: fc.record({ kind: fc.constant("copyLink" as const), choice }), weight: 1 },
    { arbitrary: fc.record({ kind: fc.constant("open" as const), person, link: choice, key: choice }), weight: 4 },
    { arbitrary: fc.record({ kind: fc.constant("revoke" as const), choice, keep }), weight: 1 },
    { arbitrary: fc.record({ kind: fc.constant("remove" as const), choice, keep }), weight: 1 },
  );

  // Indices into PEOPLE. The comments resolve each pick.
  const [ANA, BEN, CY] = [1, 2, 3];
  const examples: [Step[]][] = [
    // Removing a link's creator cuts off whoever joined through it; re-adding them at "use" brings
    // those people back at "use", and at "build" restores "build".
    [[
      { kind: "invite", actor: 0, target: ANA, role: "build" },  // owner
      { kind: "createLink", actor: 1, role: "build" },  // ana
      { kind: "open", person: BEN, link: 0, key: 0 },
      { kind: "remove", choice: 0, keep: 0 },  // owner removes ana
      { kind: "invite", actor: 0, target: ANA, role: "use" },
      { kind: "invite", actor: 0, target: ANA, role: "build" },
    ]],
    // A collaborator withdraws their own invite: ana keeps the owner's "use" invite, and cy, who
    // joined through ana's link, drops to "use" with her.
    [[
      { kind: "invite", actor: 0, target: ANA, role: "use" },
      { kind: "invite", actor: 0, target: BEN, role: "build" },
      { kind: "invite", actor: 1, target: ANA, role: "build" },  // ben
      { kind: "createLink", actor: 1, role: "build" },  // ana
      { kind: "open", person: CY, link: 0, key: 0 },
      { kind: "remove", choice: 3, keep: 0 },  // ben removes ana
    ]],
    // Revoking a link while keeping ben, who joined through it, also keeps cy, whom ben invited.
    [[
      { kind: "invite", actor: 0, target: ANA, role: "build" },
      { kind: "createLink", actor: 1, role: "build" },  // ana
      { kind: "open", person: BEN, link: 0, key: 0 },
      { kind: "invite", actor: 2, target: CY, role: "use" },  // ben
      { kind: "revoke", choice: 0, keep: 1 << BEN },  // owner revokes link 0
    ]],
    // Neither a copied key nor the original lets anyone in once the link is revoked.
    [[
      { kind: "createLink", actor: 0, role: "use" },
      { kind: "copyLink", choice: 0 },
      { kind: "open", person: ANA, link: 0, key: 1 },
      { kind: "revoke", choice: 0, keep: 0 },
      { kind: "open", person: BEN, link: 0, key: 1 },
      { kind: "open", person: ANA, link: 0, key: 0 },
    ]],
  ];

  it("gives each person the access the grants still reachable from the owner allow", async () => {
    await fc.assert(
        fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 30, size: "medium" }), replaySharing),
        { ...PROPERTY_RUN_OPTIONS, numRuns: 200, examples });
  });
});
