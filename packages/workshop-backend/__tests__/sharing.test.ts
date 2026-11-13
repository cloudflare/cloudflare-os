import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { PROPERTY_RUN_OPTIONS } from "@gadgets/scripts/property-runs";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import {
  SharingManager, SharingStorage, accessIncludesGadget,
} from "../src/sharing.js";
import {
  makeOverseerStorage, type CollaboratorRecord, type ShareKeyRecord,
} from "../src/storage-schema/overseer-storage.js";
import {
  migrateToFrozenGadgetGrants, type OverseerMigrationHost,
} from "../src/storage-schema/overseer-migrations.js";
import { createWorkshopLogger } from "../src/observability.js";
import {
  AffectedCollaborator, AiChatAuthorInfo, PermissionEdge, CollaboratorRole, CollaboratorAccess,
  CollaboratorGrant, WorkpieceId, getOpenWorkspaceErrorCode, OPEN_WORKSPACE_ERROR_CODES,
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

// `gadgets` is the set of shareable gadget ids; tests may add or delete ids to model a gadget
// being published or deleted.
function makeManager(opts: {
  ownerInvitesOnly?: () => boolean;
  gadgets?: Iterable<WorkpieceId>;
} = {}) {
  let storage = makeStorage();
  let gadgets = new Set<WorkpieceId>(opts.gadgets ?? [1, 2, 3]);
  let mgr = new SharingManager(
      storage, OWNER, opts.ownerInvitesOnly ?? (() => false), id => gadgets.has(id));
  return { storage, gadgets, mgr };
}

// A manager whose `ownerInvitesOnly` flag the test can flip at any point.
function makeManagerWithFlag() {
  let flags = { ownerInvitesOnly: false };
  return { flags, ...makeManager({ ownerInvitesOnly: () => flags.ownerInvitesOnly }) };
}

const BUILD: CollaboratorAccess = { role: "build" };
function only(...gadgetIds: WorkpieceId[]): CollaboratorAccess {
  return { role: "use", gadgetIds };
}

function profile(id: string): AiChatAuthorInfo {
  return { type: "user", id, name: id };
}

// A user edge. Legacy `use` edges without a gadget are seeded only for the version 7 migration.
function userEdge(sharer: string, role: CollaboratorRole = "build", gadgetId?: WorkpieceId)
    : PermissionEdge {
  return { type: "user", sharer, created: new Date(), role, ...(gadgetId !== undefined ? { gadgetId } : {}) };
}

function gadgetEdge(sharer: string, gadgetId: WorkpieceId): PermissionEdge {
  return userEdge(sharer, "use", gadgetId);
}

function keyEdge(keyId: string, role: CollaboratorRole = "build", gadgetId?: WorkpieceId)
    : PermissionEdge {
  return { type: "shareKey", keyId, created: new Date(), role, ...(gadgetId !== undefined ? { gadgetId } : {}) };
}

function seedCollaborator(storage: SharingStorage, id: string, addedBy: PermissionEdge[]) {
  storage.collaborators.put({ profile: profile(id), addedBy });
}

// Seed a share link. A link is stored as its first key, so `linkId` is that key's hash -- which is
// what `shareKey` edges reference.
function seedLink(
    storage: SharingStorage, linkId: string, createdBy: string,
    role: CollaboratorRole = "build", gadgetId?: WorkpieceId) {
  storage.shareKeys.put({
    id: linkId, created: new Date(), createdBy, role,
    ...(gadgetId !== undefined ? { gadgetId } : {}),
  });
}

// Seed a link to several gadgets, as frozen by migrateToFrozenGadgetGrants().
function seedLinkToGadgets(
    storage: SharingStorage, linkId: string, createdBy: string, gadgetIds: WorkpieceId[]) {
  storage.shareKeys.put({ id: linkId, created: new Date(), createdBy, role: "use", gadgetIds });
}

// Read back a link record, asserting that the id names a link rather than one of its aliases.
function link(storage: SharingStorage, linkId: string) {
  let record = storage.shareKeys.get(linkId)!;
  if (record.alias !== undefined) throw new Error(`${linkId} is an alias, not a link`);
  return record;
}

// A redeemable link to several gadgets. No such link can be created, so mint a link and rewrite
// it into that shape.
async function linkToGadgets(storage: SharingStorage, mgr: SharingManager, gadgetIds: WorkpieceId[])
    : Promise<{ key: string; linkId: string }> {
  let result = await mgr.createShareLink({ caller: owner, grant: "workspace" });
  storage.shareKeys.put({ ...link(storage, result.linkId), role: "use", gadgetIds });
  return result;
}

function ids(list: { profile: AiChatAuthorInfo }[]): string[] {
  return list.map(x => x.profile.id).toSorted();
}

function edgesOf(storage: SharingStorage, id: string): PermissionEdge[] {
  return storage.collaborators.get(id)!.addedBy;
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

  it("getEffectiveAccess returns build for the owner", () => {
    let { mgr } = makeManager();
    expect(mgr.getEffectiveAccess(OWNER)).toEqual(BUILD);
  });

  it("getEffectiveAccess returns undefined for non-collaborators", () => {
    let { mgr } = makeManager();
    expect(mgr.getEffectiveAccess("nobody")).toBeUndefined();
  });

  it("getEffectiveAccess reflects the granted access", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "builder", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "one", [gadgetEdge(OWNER, 2)]);
    expect(mgr.getEffectiveAccess("builder")).toEqual(BUILD);
    expect(mgr.getEffectiveAccess("one")).toEqual(only(2));
  });

  it("treats an edge with no role, from before roles existed, as build", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [{ type: "user", sharer: OWNER, created: new Date() }]);
    expect(mgr.getEffectiveAccess("a")).toEqual(BUILD);
  });
});

describe("accessIncludesGadget", () => {
  it("includes every id for build access, else only the listed ones", () => {
    expect(accessIncludesGadget(BUILD, 99)).toBe(true);
    expect(accessIncludesGadget(only(1, 3), 3)).toBe(true);
    expect(accessIncludesGadget(only(1, 3), 2)).toBe(false);
  });
});

describe("redeemShareKey", () => {
  it("creates a new collaborator (fetching profile) when the key is valid", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareLink({ caller: owner, grant: "workspace" });

    let fetched = 0;
    await mgr.redeemShareKey({
      rawKey: key,
      profileId: "newbie",
      fetchProfile: async () => { fetched++; return profile("newbie"); },
    });

    expect(fetched).toBe(1);
    expect(edgesOf(storage, "newbie"))
        .toEqual([expect.objectContaining({ type: "shareKey", role: "build" })]);
    expect(mgr.getEffectiveAccess("newbie")).toEqual(BUILD);
  });

  it("stamps a gadget link's edge with its gadget and grants exactly that gadget", async () => {
    let { storage, mgr } = makeManager();
    let { key, linkId } = await mgr.createShareLink({ caller: owner, grant: { gadgetId: 2 } });

    await mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => profile("a"),
    });

    expect(edgesOf(storage, "a")).toEqual([
      expect.objectContaining({ type: "shareKey", keyId: linkId, role: "use", gadgetId: 2 }),
    ]);
    let access = mgr.getEffectiveAccess("a")!;
    expect(access).toEqual(only(2));
    expect(accessIncludesGadget(access, 1)).toBe(false);
    expect(accessIncludesGadget(access, 3)).toBe(false);
  });

  it("adds a key edge to an existing collaborator without fetching the profile", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareLink({ caller: owner, grant: { gadgetId: 2 } });
    seedCollaborator(storage, "a", [gadgetEdge(OWNER, 1)]);

    let fetched = 0;
    await mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => { fetched++; return profile("a"); },
    });

    expect(fetched).toBe(0);
    expect(edgesOf(storage, "a")).toHaveLength(2);
    // The link's gadget joins the one already granted.
    expect(mgr.getEffectiveAccess("a")).toEqual(only(1, 2));
  });

  it("does not duplicate an edge for the same key", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareLink({ caller: owner, grant: "workspace" });

    await mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => profile("a"),
    });
    await mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => profile("a"),
    });

    expect(edgesOf(storage, "a")).toHaveLength(1);
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

  it("gives a newcomer one edge per shareable gadget of a link to several, and just those",
      async () => {
    let { storage, gadgets, mgr } = makeManager();
    // Gadget 9 was deleted after the link was frozen.
    let { key, linkId } = await linkToGadgets(storage, mgr, [1, 3, 9]);

    await mgr.redeemShareKey({
      rawKey: key, profileId: "newbie",
      fetchProfile: async () => profile("newbie"),
    });

    expect(edgesOf(storage, "newbie")).toEqual([
      expect.objectContaining({ type: "shareKey", keyId: linkId, role: "use", gadgetId: 1 }),
      expect.objectContaining({ type: "shareKey", keyId: linkId, role: "use", gadgetId: 3 }),
    ]);
    // A gadget published later is not among them.
    gadgets.add(42);
    expect(mgr.getEffectiveAccess("newbie")).toEqual(only(1, 3));
  });

  it("restores only the gadgets removed when a link to several is redeemed again", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await linkToGadgets(storage, mgr, [1, 3]);
    let redeem = () => mgr.redeemShareKey(
        { rawKey: key, profileId: "a", fetchProfile: async () => profile("a") });

    await redeem();
    mgr.removeCollaborator(owner, "a", [], 3);
    expect(mgr.getEffectiveAccess("a")).toEqual(only(1));

    await redeem();
    expect(edgesOf(storage, "a")).toHaveLength(2);
    expect(mgr.getEffectiveAccess("a")).toEqual(only(1, 3));
  });

  it("treats a link to a gadget that can no longer be shared as unknown", async () => {
    let { storage, gadgets, mgr } = makeManager();
    let { key, linkId } = await mgr.createShareLink({ caller: owner, grant: { gadgetId: 2 } });
    seedCollaborator(storage, "a", [keyEdge(linkId, "use", 2)]);
    gadgets.delete(2);

    await mgr.redeemShareKey({ rawKey: key, profileId: "b", fetchProfile: async () => profile("b") });

    expect(storage.collaborators.get("b")).toBeUndefined();
    // The existing recipient's grant confers nothing either, and its edge is not rewritten.
    expect(mgr.getEffectiveAccess("a")).toBeUndefined();
    expect(edgesOf(storage, "a")).toHaveLength(1);
  });
});

describe("addCollaborator", () => {
  it("adds a new collaborator with a user edge from the caller", () => {
    let { storage, mgr } = makeManager();
    let info = mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: "workspace", note: "hi" });
    expect(info.addedBy).toEqual([
      expect.objectContaining({ type: "user", sharer: OWNER, role: "build", note: "hi" }),
    ]);
    expect(info.access).toEqual(BUILD);
    expect(storage.collaborators.get("a")).toBeDefined();
  });

  it("records a gadget grant as an edge to that one gadget", () => {
    let { mgr } = makeManager();
    let info = mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: { gadgetId: 1 } });
    expect(info.addedBy).toEqual([
      expect.objectContaining({ type: "user", sharer: OWNER, role: "use", gadgetId: 1 }),
    ]);
    expect(info.access).toEqual(only(1));
  });

  it("refuses to add the owner", () => {
    let { mgr } = makeManager();
    expect(() => mgr.addCollaborator({ caller: owner, profile: profile(OWNER), grant: "workspace" }))
        .toThrow(/owner/);
  });

  it("refuses a grant of a gadget that cannot be shared", () => {
    let { storage, mgr } = makeManager();
    expect(() => mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: { gadgetId: 9 } }))
        .toThrow("No such gadget: 9");
    expect(storage.collaborators.get("a")).toBeUndefined();
  });

  it("forbids sharing by a caller without build, even a gadget they hold", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [gadgetEdge(OWNER, 1)]);
    for (let grant of ["workspace", { gadgetId: 1 }, { gadgetId: 2 }] as const) {
      expect(() => mgr.addCollaborator({ caller: collab("a"), profile: profile("b"), grant }))
          .toThrow("You do not have permission to share this workspace.");
    }
    expect(storage.collaborators.get("b")).toBeUndefined();
  });

  it("adds a second edge from a different sharer but dedups the same grant from one sharer", () => {
    let { storage, mgr } = makeManager();
    mgr.addCollaborator({ caller: owner, profile: profile("b"), grant: "workspace" });
    mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: "workspace" });
    mgr.addCollaborator({ caller: collab("b"), profile: profile("a"), grant: "workspace" });
    mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: "workspace", note: "again" });
    expect(edgesOf(storage, "a")).toHaveLength(2);
    // Re-granting only updates the note.
    expect(edgesOf(storage, "a")).toContainEqual(
        expect.objectContaining({ sharer: OWNER, role: "build", note: "again" }));
  });

  it("keeps independent grants of different gadgets from one sharer, and unions them", () => {
    let { storage, mgr } = makeManager();
    mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: { gadgetId: 1 } });
    let info = mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: { gadgetId: 2 } });
    expect(info.access).toEqual(only(1, 2));
    expect(edgesOf(storage, "a")).toEqual([
      expect.objectContaining({ sharer: OWNER, role: "use", gadgetId: 1 }),
      expect.objectContaining({ sharer: OWNER, role: "use", gadgetId: 2 }),
    ]);

    // A build grant from the same sharer covers them.
    mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: "workspace" });
    expect(mgr.getEffectiveAccess("a")).toEqual(BUILD);

    // Re-granting a gadget that build covers narrows nothing.
    mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: { gadgetId: 1 }, note: "n" });
    expect(mgr.getEffectiveAccess("a")).toEqual(BUILD);
  });
});

describe("computeEffectiveAccess", () => {
  it("propagates build along a chain", () => {
    let { storage, mgr } = makeManager();
    // owner -> a -> b
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge("a", "build")]);
    let access = mgr.computeEffectiveAccess();
    expect(access.get("a")).toEqual(BUILD);
    expect(access.get("b")).toEqual(BUILD);
  });

  it("does not support downstream grants from a holder of gadgets", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [gadgetEdge(OWNER, 1)]);
    seedCollaborator(storage, "builder", [userEdge("a", "build")]);
    seedCollaborator(storage, "viewer", [gadgetEdge("a", 1)]);
    seedLink(storage, "k1", "a", "use", 1);
    seedCollaborator(storage, "linked", [keyEdge("k1", "use", 1)]);
    expect(mgr.getEffectiveAccess("builder")).toBeUndefined();
    expect(mgr.getEffectiveAccess("viewer")).toBeUndefined();
    expect(mgr.getEffectiveAccess("linked")).toBeUndefined();
  });

  it("takes the union across multiple paths", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [gadgetEdge(OWNER, 1), userEdge("a", "build")]);
    seedCollaborator(storage, "c", [gadgetEdge(OWNER, 3), gadgetEdge("a", 1)]);
    expect(mgr.getEffectiveAccess("b")).toEqual(BUILD);
    expect(mgr.getEffectiveAccess("c")).toEqual(only(1, 3));
  });

  it("confers nothing through a grant of a gadget that cannot be shared", () => {
    let { storage, gadgets, mgr } = makeManager();
    seedCollaborator(storage, "a", [gadgetEdge(OWNER, 9)]);
    seedCollaborator(storage, "b", [gadgetEdge(OWNER, 9), gadgetEdge(OWNER, 1)]);
    expect(mgr.getEffectiveAccess("a")).toBeUndefined();
    expect(mgr.getEffectiveAccess("b")).toEqual(only(1));

    // Once the gadget can be shared, the grant counts; once deleted, it stops counting again.
    gadgets.add(9);
    expect(mgr.getEffectiveAccess("a")).toEqual(only(9));
    gadgets.delete(9);
    expect(mgr.getEffectiveAccess("a")).toBeUndefined();
  });

  it("grants nothing through a cycle unreachable from the owner", () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "kb", "b", "build");
    seedCollaborator(storage, "a", [userEdge("b", "build"), keyEdge("kb")]);
    seedCollaborator(storage, "b", [userEdge("a", "build"), gadgetEdge("a", 1)]);
    expect(mgr.computeEffectiveAccess().size).toBe(0);
    expect(mgr.listCollaborators()).toEqual([]);

    // Gadget access cannot activate a cycle of otherwise unsupported grants.
    storage.collaborators.put({ profile: profile("a"), addedBy: [
      ...edgesOf(storage, "a"), gadgetEdge(OWNER, 2)] });
    expect(mgr.getEffectiveAccess("a")).toEqual(only(2));
    expect(mgr.getEffectiveAccess("b")).toBeUndefined();

    mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: "workspace" });
    expect(mgr.getEffectiveAccess("a")).toEqual(BUILD);
    expect(mgr.getEffectiveAccess("b")).toEqual(BUILD);
  });

  it("drops a severed user and their sole dependents", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "b", [userEdge("a")]);
    let access = mgr.computeEffectiveAccess({ severed: target => target === "a" });
    expect(access.has("a")).toBe(false);
    expect(access.has("b")).toBe(false);
  });

  it("cascades share-link revocation through dependent users", () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", OWNER);
    seedCollaborator(storage, "a", [keyEdge("k1")]);
    seedCollaborator(storage, "b", [userEdge("a")]);
    let access = mgr.computeEffectiveAccess({ revokedLinkId: "k1" });
    expect(access.has("a")).toBe(false);
    expect(access.has("b")).toBe(false);
  });

  it("grants at most what the link does, through its creator, whatever the edge claims", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "creator", [userEdge(OWNER, "build")]);
    seedLink(storage, "k1", "creator", "use", 1);
    seedLinkToGadgets(storage, "k2", "creator", [1, 2]);
    // A forged edge claiming build through a gadget link grants only what the link does.
    seedCollaborator(storage, "a", [keyEdge("k1", "build")]);
    // Each edge of a link to several gadgets grants its own gadget, if the link grants it.
    seedCollaborator(storage, "b", [keyEdge("k2", "use", 2), keyEdge("k2", "use", 3)]);
    expect(mgr.getEffectiveAccess("a")).toEqual(only(1));
    expect(mgr.getEffectiveAccess("b")).toEqual(only(2));
  });
});

describe("previewRemoveCollaborator", () => {
  it("reports a transitively-removed dependent", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "b", [userEdge("a")]);
    let affected = mgr.previewRemoveCollaborator(owner, "a");
    expect(ids(affected)).toEqual(["a", "b"]);
    expect(affected.find(x => x.profile.id === "b")!.newAccess).toBe(null);
  });

  it("reports a narrowing rather than a removal", () => {
    let { storage, mgr } = makeManager();
    // b has build via a, but also gadget 1 directly from the owner.
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [gadgetEdge(OWNER, 1), userEdge("a", "build")]);
    let b = mgr.previewRemoveCollaborator(owner, "a").find(x => x.profile.id === "b")!;
    expect(b.oldAccess).toEqual(BUILD);
    expect(b.newAccess).toEqual(only(1));
  });

  it("previews removing one gadget without changing storage", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "b", [gadgetEdge(OWNER, 1), gadgetEdge(OWNER, 2)]);
    expect(mgr.previewRemoveCollaborator(owner, "b", 1)).toEqual([
      expect.objectContaining({ profile: profile("b"), oldAccess: only(1, 2), newAccess: only(2) }),
    ]);
    expect(edgesOf(storage, "b")).toHaveLength(2);
    expect(mgr.getEffectiveAccess("b")).toEqual(only(1, 2));
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
    expect(mgr.getEffectiveAccess("a")).toBeUndefined();
    expect(mgr.getEffectiveAccess("b")).toBeUndefined();
  });

  it("owner severs ALL incoming edges to the target", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    // t is reachable via both the owner and a, for the workspace and individual gadgets.
    seedCollaborator(storage, "t", [userEdge(OWNER), userEdge("a"), gadgetEdge(OWNER, 1)]);

    mgr.removeCollaborator(owner, "t", []);
    expect(edgesOf(storage, "t")).toEqual([]);
    expect(mgr.getEffectiveAccess("t")).toBeUndefined();
  });

  it("restores downstream invitations only when re-added with build access", async () => {
    let { mgr } = makeManager();
    mgr.addCollaborator({ caller: owner, profile: profile("bob"), grant: "workspace" });
    mgr.addCollaborator({ caller: collab("bob"), profile: profile("carol"), grant: "workspace" });
    mgr.addCollaborator({ caller: owner, profile: profile("carol"), grant: { gadgetId: 2 } });
    let { key } = await mgr.createShareLink({ caller: collab("bob"), grant: { gadgetId: 1 } });
    await mgr.redeemShareKey({ rawKey: key, profileId: "dave", fetchProfile: async () => profile("dave") });
    expect(mgr.getEffectiveAccess("carol")).toEqual(BUILD);
    expect(mgr.getEffectiveAccess("dave")).toEqual(only(1));

    mgr.removeCollaborator(owner, "bob", []);
    expect(mgr.getEffectiveAccess("bob")).toBeUndefined();
    expect(mgr.getEffectiveAccess("carol")).toEqual(only(2));
    expect(mgr.getEffectiveAccess("dave")).toBeUndefined();

    mgr.addCollaborator({ caller: owner, profile: profile("bob"), grant: { gadgetId: 1 } });
    expect(mgr.getEffectiveAccess("bob")).toEqual(only(1));
    expect(mgr.getEffectiveAccess("carol")).toEqual(only(2));
    expect(mgr.getEffectiveAccess("dave")).toBeUndefined();
    expect(ids(mgr.listCollaborators())).toEqual(["bob", "carol"]);

    mgr.addCollaborator({ caller: owner, profile: profile("bob"), grant: "workspace" });
    expect(mgr.getEffectiveAccess("bob")).toEqual(BUILD);
    expect(mgr.getEffectiveAccess("carol")).toEqual(BUILD);
    expect(mgr.getEffectiveAccess("dave")).toEqual(only(1));
  });

  it("re-roots a kept dependent under the caller", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "b", [userEdge("a")]);

    let affected = mgr.removeCollaborator(owner, "a", ["b"]);
    expect(ids(affected)).toEqual(["a"]);  // b is kept, so not reported
    expect(mgr.getEffectiveAccess("b")).toEqual(BUILD);
    // b gained a fresh edge from the caller.
    expect(edgesOf(storage, "b"))
        .toContainEqual(expect.objectContaining({ type: "user", sharer: OWNER, role: "build" }));
  });

  it("keeps a narrowed user at their prior access when kept", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [gadgetEdge(OWNER, 1), userEdge("a", "build")]);

    let affected = mgr.removeCollaborator(owner, "a", ["b"]);
    expect(ids(affected)).toEqual(["a"]);
    expect(mgr.getEffectiveAccess("b")).toEqual(BUILD);
  });

  it("restores exactly the lost gadgets to a kept user, never more", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [gadgetEdge("a", 1), gadgetEdge("a", 2), gadgetEdge(OWNER, 3)]);

    mgr.removeCollaborator(owner, "a", ["b"]);

    expect(mgr.getEffectiveAccess("b")).toEqual(only(1, 2, 3));
    let ownerEdges = edgesOf(storage, "b").filter(e => e.type === "user" && e.sharer === OWNER);
    expect(ownerEdges).toHaveLength(3);
    expect(ownerEdges.map(e => [e.role, e.gadgetId])).toEqual(
        expect.arrayContaining([["use", 3], ["use", 1], ["use", 2]]));
  });

  it("narrows a non-kept user instead of removing them", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [gadgetEdge(OWNER, 1), userEdge("a", "build")]);

    let affected = mgr.removeCollaborator(owner, "a", []);
    expect(ids(affected)).toEqual(["a", "b"]);
    expect(affected.find(x => x.profile.id === "b")!.newAccess).toEqual(only(1));
    // b retains gadget 1; its (now-inert) edge from a is left untouched (lazy).
    expect(mgr.getEffectiveAccess("b")).toEqual(only(1));
    expect(edgesOf(storage, "b")).toHaveLength(2);
  });

  it("does not prune now-inert edges from surviving collaborators (lazy)", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    // c is supported by the owner directly, but also carries an edge from a.
    seedCollaborator(storage, "c", [userEdge(OWNER), userEdge("a")]);

    mgr.removeCollaborator(owner, "a", []);
    // c keeps full access; the inert edge from a remains in storage.
    expect(mgr.getEffectiveAccess("c")).toEqual(BUILD);
    expect(edgesOf(storage, "c")).toHaveLength(2);
  });

  it("lets a non-owner remove only their own edge, sparing the target if others remain", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "t", [userEdge(OWNER), userEdge("a")]);

    let affected = mgr.removeCollaborator(collab("a"), "t", []);
    expect(affected).toEqual([]);
    expect(edgesOf(storage, "t"))
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

  it("lets the owner remove one gadget, keeping the others and reporting the change", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [gadgetEdge(OWNER, 1), gadgetEdge(OWNER, 2), gadgetEdge("a", 1)]);

    let affected = mgr.removeCollaborator(owner, "b", [], 1);

    expect(affected).toEqual([
      expect.objectContaining({ profile: profile("b"), oldAccess: only(1, 2), newAccess: only(2) }),
    ]);
    // Every edge granting gadget 1 is severed, whoever gave it; the gadget 2 grant survives.
    expect(edgesOf(storage, "b")).toEqual([expect.objectContaining({ sharer: OWNER, gadgetId: 2 })]);
    expect(mgr.getEffectiveAccess("b")).toEqual(only(2));
    expect(mgr.getEffectiveAccess("a")).toEqual(BUILD);
  });

  it("removes one gadget of a link to several, but never a build edge", () => {
    let { storage, mgr } = makeManager();
    seedLinkToGadgets(storage, "k1", OWNER, [1, 2]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "build"), gadgetEdge(OWNER, 1)]);
    seedCollaborator(storage, "c", [keyEdge("k1", "use", 1), keyEdge("k1", "use", 2)]);

    expect(mgr.removeCollaborator(owner, "b", [], 1)).toEqual([]);
    expect(mgr.getEffectiveAccess("b")).toEqual(BUILD);

    expect(mgr.removeCollaborator(owner, "c", [], 1)).toEqual([
      expect.objectContaining({ profile: profile("c"), oldAccess: only(1, 2), newAccess: only(2) }),
    ]);
    expect(edgesOf(storage, "c")).toEqual([expect.objectContaining({ keyId: "k1", gadgetId: 2 })]);
  });

  it("lets a non-owner remove their own grant of one gadget", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [gadgetEdge("a", 1), gadgetEdge("a", 2), gadgetEdge(OWNER, 1)]);
    seedCollaborator(storage, "c", [gadgetEdge("a", 1)]);

    let affected = mgr.removeCollaborator(collab("a"), "b", [], 2);

    expect(affected).toEqual([
      expect.objectContaining({ profile: profile("b"), oldAccess: only(1, 2), newAccess: only(1) }),
    ]);
    expect(edgesOf(storage, "b")).toHaveLength(2);
    expect(mgr.getEffectiveAccess("b")).toEqual(only(1));

    // a gave c no gadget 2, so there's nothing of a's to remove.
    expect(() => mgr.removeCollaborator(collab("a"), "c", [], 2)).toThrow(/only remove users/);
    expect(mgr.getEffectiveAccess("c")).toEqual(only(1));
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
    expect(mgr.getEffectiveAccess("a")).toBeUndefined();
    expect(mgr.getEffectiveAccess("b")).toBeUndefined();
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
    expect(mgr.getEffectiveAccess("b")).toBeUndefined();

    // Undo: re-add a, and b regains access through k2.
    mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: "workspace" });
    expect(mgr.getEffectiveAccess("b")).toEqual(BUILD);
  });

  it("revoking a gadget link removes only what depended on it", () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", OWNER, "use", 1);
    seedCollaborator(storage, "a", [keyEdge("k1", "use", 1), gadgetEdge(OWNER, 2)]);
    seedCollaborator(storage, "b", [keyEdge("k1", "use", 1)]);
    seedCollaborator(storage, "c", [gadgetEdge(OWNER, 1)]);

    expect(mgr.previewRevokeShareLink(owner, "k1")).toEqual([
      expect.objectContaining({ profile: profile("a"), oldAccess: only(1, 2), newAccess: only(2) }),
      expect.objectContaining({ profile: profile("b"), oldAccess: only(1), newAccess: null }),
    ]);
    let affected = mgr.revokeShareLink(owner, "k1", []);
    expect(ids(affected)).toEqual(["a", "b"]);
    expect(mgr.getEffectiveAccess("a")).toEqual(only(2));
    expect(mgr.getEffectiveAccess("b")).toBeUndefined();
    expect(mgr.getEffectiveAccess("c")).toEqual(only(1));
  });

  it("re-roots a kept gadget link recipient with just that gadget", () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", OWNER, "use", 1);
    seedCollaborator(storage, "a", [keyEdge("k1", "use", 1)]);

    expect(mgr.revokeShareLink(owner, "k1", ["a"])).toEqual([]);
    expect(mgr.getEffectiveAccess("a")).toEqual(only(1));
    expect(edgesOf(storage, "a")).toContainEqual(
        expect.objectContaining({ type: "user", sharer: OWNER, role: "use", gadgetId: 1 }));
  });

  it("revokes a link to several gadgets, keeping recipients only on request", () => {
    let { storage, mgr } = makeManager();
    seedLinkToGadgets(storage, "k1", OWNER, [1, 2]);
    let linkEdges = [keyEdge("k1", "use", 1), keyEdge("k1", "use", 2)];
    seedCollaborator(storage, "a", linkEdges);
    seedCollaborator(storage, "b", [...linkEdges, gadgetEdge(OWNER, 3)]);

    let affected = mgr.revokeShareLink(owner, "k1", ["b"]);
    expect(affected).toEqual([
      expect.objectContaining({ profile: profile("a"), oldAccess: only(1, 2), newAccess: null }),
    ]);
    expect(mgr.getEffectiveAccess("a")).toBeUndefined();
    // b keeps the link's gadgets beside their own.
    expect(mgr.getEffectiveAccess("b")).toEqual(only(1, 2, 3));
  });

  it("a revoked link's keys can no longer be redeemed", async () => {
    let { storage, mgr } = makeManager();
    let { key, linkId } = await mgr.createShareLink({ caller: owner, grant: { gadgetId: 1 } });

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
  it("persists the granted gadget", async () => {
    let { mgr } = makeManager();
    let { key, linkId } = await mgr.createShareLink({ caller: owner, grant: { gadgetId: 2 } });
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    let records = mgr.listShareLinkRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ role: "use", gadgetId: 2 });
    // The caller is told which link it created, so it never has to infer it from the list.
    expect(linkId).toBe(records[0].id);
  });

  it("persists a build link with no gadget", async () => {
    let { mgr } = makeManager();
    await mgr.createShareLink({ caller: owner, grant: "workspace" });
    let [record] = mgr.listShareLinkRecords();
    expect(record.role).toBe("build");
    expect(record.gadgetId).toBeUndefined();
  });

  it("refuses a link to a gadget that cannot be shared", async () => {
    let { mgr } = makeManager();
    await expect(mgr.createShareLink({ caller: owner, grant: { gadgetId: 9 } }))
        .rejects.toThrow("No such gadget: 9");
    expect(mgr.listShareLinkRecords()).toEqual([]);
  });

  it("forbids a caller without build from creating a link, even to a gadget they hold", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [gadgetEdge(OWNER, 1)]);
    for (let grant of ["workspace", { gadgetId: 1 }, { gadgetId: 2 }] as const) {
      await expect(mgr.createShareLink({ caller: collab("a"), grant }))
          .rejects.toThrow("You do not have permission to share this workspace.");
    }
    expect(mgr.listShareLinkRecords()).toEqual([]);
  });
});

describe("default share links", () => {
  it("gives a caller one default link per grant, even when created concurrently", async () => {
    let { storage, mgr } = makeManager();
    let [first, second] = await Promise.all([
      mgr.createShareLink({ caller: owner, grant: "workspace", default: true }),
      mgr.createShareLink({ caller: owner, grant: "workspace", default: true }),
    ]);
    expect(second.linkId).toBe(first.linkId);
    expect(second.key).not.toBe(first.key);
    expect(mgr.listShareLinkRecords().map(record => record.id)).toEqual([first.linkId]);
    expect(link(storage, first.linkId).default).toBe(true);

    // Either key joins through the one link.
    for (let [profileId, rawKey] of [["a", first.key], ["b", second.key]]) {
      await mgr.redeemShareKey({ rawKey, profileId, fetchProfile: async () => profile(profileId) });
      expect(edgesOf(storage, profileId)).toEqual([
        expect.objectContaining({ type: "shareKey", keyId: first.linkId }),
      ]);
    }
  });

  it("keeps each creator's and each grant's default apart from the rest", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "bob", [userEdge(OWNER)]);
    let named = await mgr.createShareLink({ caller: owner, grant: "workspace", note: "team" });
    let ownerWorkspace =
        await mgr.createShareLink({ caller: owner, grant: "workspace", default: true });
    let ownerGadget =
        await mgr.createShareLink({ caller: owner, grant: { gadgetId: 1 }, default: true });
    let bobWorkspace =
        await mgr.createShareLink({ caller: collab("bob"), grant: "workspace", default: true });

    let linkIds = [named, ownerWorkspace, ownerGadget, bobWorkspace].map(result => result.linkId);
    expect(new Set(linkIds).size).toBe(4);
    expect(link(storage, named.linkId).default).toBeUndefined();
  });

  it("creates a fresh default once the previous one is revoked", async () => {
    let { mgr } = makeManager();
    let revoked =
        await mgr.createShareLink({ caller: owner, grant: { gadgetId: 2 }, default: true });
    mgr.revokeShareLink(owner, revoked.linkId, []);

    let fresh =
        await mgr.createShareLink({ caller: owner, grant: { gadgetId: 2 }, default: true });
    expect(fresh.linkId).not.toBe(revoked.linkId);
    expect(mgr.listShareLinkRecords().map(record => record.id)).toEqual([fresh.linkId]);
  });
});

describe("newShareLinkKey", () => {
  it("mints a new key for the same link that redeems to one grant", async () => {
    let { storage, mgr } = makeManager();
    let { key: key1, linkId } =
        await mgr.createShareLink({ caller: owner, grant: { gadgetId: 1 }, note: "team" });

    let { key: key2 } = await mgr.newShareLinkKey({ caller: owner, linkId });
    expect(key2).not.toBe(key1);

    // Two secret records, one logical link: listing still shows a single entry, and the new
    // secret inherits the link's note and grant.
    expect([...storage.shareKeys.list()]).toHaveLength(2);
    let listed = mgr.listShareLinkRecords();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ role: "use", gadgetId: 1, note: "team" });

    // Both secrets redeem, and a user redeeming both gets a single (deduplicated) edge.
    await mgr.redeemShareKey({ rawKey: key1, profileId: "a", fetchProfile: async () => profile("a") });
    await mgr.redeemShareKey({ rawKey: key2, profileId: "a", fetchProfile: async () => profile("a") });
    expect(edgesOf(storage, "a")).toHaveLength(1);
    expect(mgr.getEffectiveAccess("a")).toEqual(only(1));
  });

  it("revoking a link revokes every key minted for it", async () => {
    let { storage, mgr } = makeManager();
    let { key: key1, linkId } = await mgr.createShareLink({ caller: owner, grant: "workspace" });
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

  it("copies a link to several gadgets to a key that redeems to the same gadgets", async () => {
    let { storage, mgr } = makeManager();
    let { linkId } = await linkToGadgets(storage, mgr, [1, 3]);
    let { key } = await mgr.newShareLinkKey({ caller: owner, linkId });

    await mgr.redeemShareKey({ rawKey: key, profileId: "a", fetchProfile: async () => profile("a") });

    expect(edgesOf(storage, "a")).toEqual([
      expect.objectContaining({ type: "shareKey", keyId: linkId, gadgetId: 1 }),
      expect.objectContaining({ type: "shareKey", keyId: linkId, gadgetId: 3 }),
    ]);
    expect(mgr.getEffectiveAccess("a")).toEqual(only(1, 3));
  });

  it("refuses to copy a link to a gadget that can no longer be shared", async () => {
    let { storage, gadgets, mgr } = makeManager();
    let { linkId } = await mgr.createShareLink({ caller: owner, grant: { gadgetId: 2 } });
    gadgets.delete(2);
    await expect(mgr.newShareLinkKey({ caller: owner, linkId })).rejects.toThrow(/not found/);
    expect([...storage.shareKeys.list()].map(r => r.id)).toEqual([linkId]);
  });

  it("forbids a non-owner from copying a link they didn't create", async () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", OWNER);
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    await expect(mgr.newShareLinkKey({ caller: collab("a"), linkId: "k1" }))
        .rejects.toThrow(/only copy/);
  });

  it("forbids copying a link once its creator no longer holds build", async () => {
    let { storage, mgr } = makeManager();
    // "a" created a build link and a gadget 1 link, then was narrowed to gadget 1.
    seedLink(storage, "k1", "a", "build");
    seedLink(storage, "k2", "a", "use", 1);
    seedCollaborator(storage, "a", [gadgetEdge(OWNER, 1)]);
    for (let linkId of ["k1", "k2"]) {
      await expect(mgr.newShareLinkKey({ caller: collab("a"), linkId }))
          .rejects.toThrow("You do not have permission to share this workspace.");
    }
  });

  it("cannot manage a link through the id of one of its copies", async () => {
    let { storage, mgr } = makeManager();
    let { linkId } = await mgr.createShareLink({ caller: owner, grant: "workspace" });
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
  it("reads a key written before link copies or roles existed as a build link", async () => {
    let { storage, mgr } = makeManager();
    // A key written before copies existed already has the shape of a link, and its edges already
    // point at the hash, so it reads back as a link with no migration. No role means build.
    storage.shareKeys.put({
      id: "hash1", note: "team", created: new Date("2025-01-01"), createdBy: OWNER,
    });
    seedCollaborator(storage, "a", [{ type: "shareKey", keyId: "hash1", created: new Date() }]);

    expect(mgr.listShareLinkRecords()).toMatchObject([{ id: "hash1", note: "team", createdBy: OWNER }]);
    expect(mgr.getEffectiveAccess("a")).toEqual(BUILD);

    // Such a link can also be copied, and the copy grants the same access.
    let { key } = await mgr.newShareLinkKey({ caller: owner, linkId: "hash1" });
    await mgr.redeemShareKey(
        { rawKey: key, profileId: "b", fetchProfile: async () => profile("b") });
    expect(mgr.getEffectiveAccess("b")).toEqual(BUILD);
  });
});

describe("listCollaborators", () => {
  it("includes each collaborator's effective access", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "c", [gadgetEdge(OWNER, 3), gadgetEdge(OWNER, 1)]);
    let list = mgr.listCollaborators();
    expect(list.find(x => x.profile.id === "a")!.access).toEqual(BUILD);
    expect(list.find(x => x.profile.id === "c")!.access).toEqual(only(1, 3));
  });

  it("omits collaborators who linger in storage but are unreachable", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    seedCollaborator(storage, "dead", []);  // record with no incoming edges
    seedCollaborator(storage, "deleted", [gadgetEdge(OWNER, 9)]);  // grant of a missing gadget
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

    await expect(mgr.createShareLink({ caller: owner, grant: { gadgetId: 1 } }))
        .rejects.toThrow(/Share links are disabled/);
    await expect(mgr.newShareLinkKey({ caller: owner, linkId: "k1" }))
        .rejects.toThrow(/Share links are disabled/);
    expect([...storage.shareKeys.list()].map(r => r.id)).toEqual(["k1"]);

    // Link management isn't an open() failure, so it carries no open-workspace code.
    let error = await mgr.createShareLink({ caller: owner, grant: { gadgetId: 1 } }).catch(e => e);
    expect(getOpenWorkspaceErrorCode(error)).toBeUndefined();
  });

  it("persists nothing when the flag flips while a key is being minted", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedLink(storage, "k1", OWNER);

    // Both calls park in #mintKey's await, and check the flag only once it resolves.
    let created = mgr.createShareLink({ caller: owner, grant: { gadgetId: 1 } });
    let copied = mgr.newShareLinkKey({ caller: owner, linkId: "k1" });
    flags.ownerInvitesOnly = true;

    await expect(created).rejects.toThrow(/Share links are disabled/);
    await expect(copied).rejects.toThrow(/Share links are disabled/);
    expect([...storage.shareKeys.list()].map(r => r.id)).toEqual(["k1"]);
  });

  it("refuses a new user redeeming a link created before ownerInvitesOnly", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    let { key } = await mgr.createShareLink({ caller: owner, grant: "workspace" });
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
    let { key } = await mgr.createShareLink({ caller: owner, grant: { gadgetId: 1 } });

    await expect(mgr.redeemShareKey({
      rawKey: key, profileId: "newbie",
      fetchProfile: async () => { flags.ownerInvitesOnly = true; return profile("newbie"); },
    })).rejects.toMatchObject({ code: OPEN_WORKSPACE_ERROR_CODES.shareLinksDisabled });
    expect(storage.collaborators.get("newbie")).toBeUndefined();
  });

  it("lets a direct collaborator reopen a link without adding an edge", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    let { key } = await mgr.createShareLink({ caller: owner, grant: "workspace" });
    seedCollaborator(storage, "a", [gadgetEdge(OWNER, 1)]);
    flags.ownerInvitesOnly = true;

    await mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => profile("a"),
    });

    // No new grant: still just the owner's edge, granting its original gadget.
    expect(edgesOf(storage, "a")).toEqual([
      expect.objectContaining({ type: "user", sharer: OWNER }),
    ]);
    expect(mgr.getEffectiveAccess("a")).toEqual(only(1));
  });

  it("refuses an existing collaborator the owner did not add directly", async () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    let { key, linkId } = await mgr.createShareLink({ caller: owner, grant: "workspace" });
    seedCollaborator(storage, "a", [keyEdge(linkId)]);
    flags.ownerInvitesOnly = true;

    await expect(mgr.redeemShareKey({
      rawKey: key, profileId: "a",
      fetchProfile: async () => profile("a"),
    })).rejects.toMatchObject({ code: OPEN_WORKSPACE_ERROR_CODES.shareLinksDisabled });
    expect(edgesOf(storage, "a")).toEqual([
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

    expect(() => mgr.addCollaborator({ caller: collab("a"), profile: profile("b"), grant: { gadgetId: 1 } }))
        .toThrow(/Only the workspace owner/);
    expect(storage.collaborators.get("b")).toBeUndefined();

    mgr.addCollaborator({ caller: owner, profile: profile("b"), grant: { gadgetId: 1 } });
    expect(mgr.getEffectiveAccess("b")).toEqual(only(1));
  });

  it("keeps link management available to the owner", () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedLink(storage, "k1", OWNER);
    seedCollaborator(storage, "a", [keyEdge("k1"), gadgetEdge(OWNER, 1)]);
    flags.ownerInvitesOnly = true;

    expect(mgr.listShareLinkRecords().map(r => r.id)).toEqual(["k1"]);
    mgr.updateShareLink(owner, "k1", "renamed");
    // The link already grants nothing, so revoking it changes nobody's access.
    expect(mgr.revokeShareLink(owner, "k1", [])).toEqual([]);
    expect(mgr.getEffectiveAccess("a")).toEqual(only(1));
    expect(ids(mgr.removeCollaborator(owner, "a", []))).toEqual(["a"]);
  });

  it("counts only direct owner grants", () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedLink(storage, "k1", OWNER);
    seedCollaborator(storage, "direct", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "linked", [keyEdge("k1")]);
    seedCollaborator(storage, "transitive", [userEdge("direct", "build")]);
    let baseline = mgr.computeEffectiveAccess();
    expect(ids(mgr.listCollaborators())).toEqual(["direct", "linked", "transitive"]);

    flags.ownerInvitesOnly = true;

    expect(mgr.getEffectiveAccess("direct")).toEqual(BUILD);
    expect(mgr.getEffectiveAccess("linked")).toBeUndefined();
    expect(mgr.getEffectiveAccess("transitive")).toBeUndefined();
    expect(ids(mgr.listCollaborators())).toEqual(["direct"]);
    expect(mgr.computeAffectedByOwnerInvitesOnly(baseline)).toEqual([
      expect.objectContaining({ profile: profile("linked"), oldAccess: BUILD, newAccess: null }),
      expect.objectContaining({ profile: profile("transitive"), oldAccess: BUILD, newAccess: null }),
    ]);
  });

  it("counts a direct owner grant of one gadget only for that gadget", () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedLink(storage, "k3", OWNER, "use", 3);
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    // b holds gadget 1 from the owner, gadget 2 through a, and gadget 3 through a link.
    seedCollaborator(storage, "b", [gadgetEdge(OWNER, 1), gadgetEdge("a", 2), keyEdge("k3", "use", 3)]);
    let baseline = mgr.computeEffectiveAccess();
    expect(baseline.get("b")).toEqual(only(1, 2, 3));

    flags.ownerInvitesOnly = true;

    expect(mgr.getEffectiveAccess("b")).toEqual(only(1));
    expect(mgr.computeAffectedByOwnerInvitesOnly(baseline)).toEqual([
      expect.objectContaining({ profile: profile("b"), oldAccess: only(1, 2, 3), newAccess: only(1) }),
    ]);
  });

  it("counts a user the owner kept during a removal as direct", () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [gadgetEdge("a", 1)]);

    // Removing a while keeping b re-roots b on an edge from the owner.
    mgr.removeCollaborator(owner, "a", ["b"]);
    flags.ownerInvitesOnly = true;

    expect(mgr.getEffectiveAccess("b")).toEqual(only(1));
  });

  it("narrows a collaborator to what their owner edges grant", () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [gadgetEdge(OWNER, 1), userEdge("a", "build")]);
    let baseline = mgr.computeEffectiveAccess();
    expect(baseline.get("b")).toEqual(BUILD);

    flags.ownerInvitesOnly = true;

    expect(mgr.getEffectiveAccess("b")).toEqual(only(1));
    expect(mgr.computeAffectedByOwnerInvitesOnly(baseline)).toEqual([
      expect.objectContaining({ profile: profile("b"), oldAccess: BUILD, newAccess: only(1) }),
    ]);
  });

  it("re-adding an intermediary restores nobody else", () => {
    let { storage, flags, mgr } = makeManagerWithFlag();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [gadgetEdge("a", 1)]);

    mgr.removeCollaborator(owner, "a", []);
    expect(mgr.getEffectiveAccess("b")).toBeUndefined();
    flags.ownerInvitesOnly = true;

    // Without the flag, re-adding a would bring b back through a's untouched edge. Once it is set,
    // only the owner's direct grants count, so b stays out until the owner adds them directly.
    mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: "workspace" });
    expect(mgr.getEffectiveAccess("a")).toEqual(BUILD);
    expect(mgr.getEffectiveAccess("b")).toBeUndefined();

    mgr.addCollaborator({ caller: owner, profile: profile("b"), grant: { gadgetId: 1 } });
    expect(mgr.getEffectiveAccess("b")).toEqual(only(1));
  });
});

// ---------------------------------------------------------------------------------------------
// Property: the sharing graph under the actions the Share dialog offers. fast-check generates a
// sequence of steps by the owner and four other people -- invite someone by name, create a share
// link, copy it, open a link, revoke a link, remove someone -- and replays it against a
// SharingManager. Each invite and link grants the workspace or one gadget. Removal and revocation
// go through the dialog's flow: preview, then confirm with some of the previewed people kept.
// After every step each person's access is checked against a model.
//
// The model keeps only the grants: what each person granted whom (all of it, since a repeat
// invite from the same person never narrows what they granted), which links each person opened,
// and which links are revoked. Access follows the rule the module documents: a grant counts only
// while its sharer (a link's creator) holds "build", and the owner holds "build". So "build" is
// reachability from the owner over grants of the workspace, and anyone else may use each gadget a
// "build" holder granted them. A link's grants come from its creator. Removal and revocation never
// touch other people's grants; downstream people just stop being reachable, and come back when a
// path does. Keeping someone gives them fresh grants from the actor of what they lost.
//
// Steps only take actions the Workshop offers the acting person: only someone with "build" can
// share (a "use" session is refused every sharing call), so someone who lost it cannot act at
// all; a collaborator removes only people they invited and revokes or copies only links they
// created; and the dialog lists only people who currently have access and live links. Anyone may
// open any link they were sent, live or revoked, with or without access.
// Scenarios a seed might miss are pinned as `examples`.

const PEOPLE = [OWNER, "ana", "ben", "cy", "dot"];
// The gadgets the steps share; makeManager's workspace has them all.
const SHARED_GADGETS: WorkpieceId[] = [1, 2];

// `person` and `target` are indices into PEOPLE (0 is the owner). Every other number picks, modulo
// the count, from what is on offer when the step runs: `actor` among the people who can share
// (the owner, then the rest in PEOPLE order); `choice` among the dialog's (actor, link) or (actor,
// person) pairs, by actor and then by link creation or PEOPLE order; `link` and `key` among every
// link created so far and that link's keys. `keep` is a bitmask over PEOPLE indices choosing which
// previewed people to keep.
type Step =
  | { kind: "invite"; actor: number; target: number; grant: CollaboratorGrant }
  | { kind: "createLink"; actor: number; grant: CollaboratorGrant }
  | { kind: "copyLink"; choice: number }
  | { kind: "open"; person: number; link: number; key: number }
  | { kind: "revoke"; choice: number; keep: number }
  | { kind: "remove"; choice: number; keep: number };

// One grant in the model: "build" of the workspace, or use of one gadget.
type ModelGrant = "build" | WorkpieceId;

function modelGrant(grant: CollaboratorGrant): ModelGrant {
  return grant === "workspace" ? "build" : grant.gadgetId;
}

function describeGrant(grant: CollaboratorGrant): string {
  return grant === "workspace" ? "the workspace" : `gadget ${grant.gadgetId}`;
}

// Whether going from `before` to `after` (undefined: no access) narrows what someone may do.
function narrows(before: CollaboratorAccess, after: CollaboratorAccess | undefined): boolean {
  if (!after) return true;
  if (before.role === "build") return after.role !== "build";
  return SHARED_GADGETS.some(id => accessIncludesGadget(before, id) && !accessIncludesGadget(after, id));
}

// The grants restoring what someone with `prior` access lost on dropping to `now`.
function lostGrants(prior: CollaboratorAccess, now: CollaboratorAccess | undefined): ModelGrant[] {
  if (prior.role === "build") return ["build"];
  return SHARED_GADGETS.filter(id => accessIncludesGadget(prior, id) && !(now && accessIncludesGadget(now, id)));
}

type ModelLink = { id: string; creator: string; grant: ModelGrant; revoked: boolean; keys: string[] };

class SharingModel {
  /** target -> inviter -> everything that inviter granted them. */
  invites = new Map<string, Map<string, Set<ModelGrant>>>();
  /** person -> ids of the links they opened. */
  opened = new Map<string, Set<string>>();
  links: ModelLink[] = [];

  invite(target: string, inviter: string, grant: ModelGrant) {
    let inviters = this.invites.get(target) ?? new Map<string, Set<ModelGrant>>();
    inviters.set(inviter, (inviters.get(inviter) ?? new Set()).add(grant));
    this.invites.set(target, inviters);
  }

  open(person: string, linkId: string) {
    this.opened.set(person, (this.opened.get(person) ?? new Set()).add(linkId));
  }

  /** Everyone but the owner who has access, with that access. */
  accesses(): Map<string, CollaboratorAccess> {
    let edges: { from: string; to: string; grant: ModelGrant }[] = [];
    for (let [to, inviters] of this.invites) {
      for (let [from, grants] of inviters) {
        for (let grant of grants) edges.push({ from, to, grant });
      }
    }
    for (let [to, linkIds] of this.opened) {
      for (let shareLink of this.links) {
        if (linkIds.has(shareLink.id) && !shareLink.revoked) {
          edges.push({ from: shareLink.creator, to, grant: shareLink.grant });
        }
      }
    }
    let builders = new Set([OWNER]);
    for (let grew = true; grew;) {
      grew = false;
      for (let edge of edges) {
        if (edge.grant === "build" && builders.has(edge.from) && !builders.has(edge.to)) {
          builders.add(edge.to);
          grew = true;
        }
      }
    }
    let users = new Map<string, Set<WorkpieceId>>();
    for (let edge of edges) {
      if (edge.grant !== "build" && builders.has(edge.from) && !builders.has(edge.to)) {
        users.set(edge.to, (users.get(edge.to) ?? new Set()).add(edge.grant));
      }
    }
    builders.delete(OWNER);
    let result = new Map<string, CollaboratorAccess>();
    for (let id of builders) result.set(id, BUILD);
    for (let [id, gadgetIds] of users) result.set(id, only(...[...gadgetIds].toSorted((a, b) => a - b)));
    return result;
  }

  access(id: string): CollaboratorAccess | undefined {
    return id === OWNER ? BUILD : this.accesses().get(id);
  }
}

type Change = { id: string; oldAccess: CollaboratorAccess; newAccess: CollaboratorAccess | null };

// The people whose access narrowed going from `before` to `after`. (None of these steps widens
// anyone's.)
function changes(before: Map<string, CollaboratorAccess>, after: Map<string, CollaboratorAccess>): Change[] {
  let result: Change[] = [];
  for (let [id, oldAccess] of before) {
    let newAccess = after.get(id);
    if (narrows(oldAccess, newAccess)) result.push({ id, oldAccess, newAccess: newAccess ?? null });
  }
  return result.toSorted((a, b) => a.id.localeCompare(b.id));
}

function reported(list: AffectedCollaborator[]): Change[] {
  return list.map(x => ({ id: x.profile.id, oldAccess: x.oldAccess, newAccess: x.newAccess }))
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
  let sharers = () => PEOPLE.filter(id => model.access(id)?.role === "build");
  // The live links each sharer may revoke or copy: any, for the owner; their own, for anyone else.
  let linkActions = () => sharers().flatMap(actor => model.links
      .filter(shareLink => !shareLink.revoked && (actor === OWNER || shareLink.creator === actor))
      .map(shareLink => ({ actor, shareLink })));
  // The people each sharer may remove: anyone with access, for the owner; people they invited who
  // still have access, for anyone else.
  let removals = () => {
    let accesses = model.accesses();
    return sharers().flatMap(actor => PEOPLE
        .filter(target => accesses.has(target) && target !== actor
            && (actor === OWNER || model.invites.get(target)?.has(actor)))
        .map(target => ({ actor, target })));
  };

  // Confirm a previewed removal or revocation, keeping the previewed people `keep` selects (never
  // the person being removed, whom the dialog does not offer). The preview must name exactly who
  // the model says loses access or some of it; the confirmation, the same minus whoever the kept
  // people's fresh grants restore.
  let confirm = (opts: {
    label: string; actor: string; keep: number; before: Map<string, CollaboratorAccess>;
    preview: Change[]; target?: string; commit: (keepUsers: string[]) => Change[];
  }) => {
    let afterSever = model.accesses();
    expect(opts.preview, `${opts.label}: preview`).toEqual(changes(opts.before, afterSever));
    let keepUsers = opts.preview.map(x => x.id)
        .filter(id => id !== opts.target && (opts.keep & (1 << PEOPLE.indexOf(id))) !== 0);
    let actual = opts.commit(keepUsers);
    for (let id of keepUsers) {
      for (let grant of lostGrants(opts.before.get(id)!, afterSever.get(id))) {
        model.invite(id, opts.actor, grant);
      }
    }
    expect(actual, `${opts.label} keeping [${keepUsers.join(", ")}]: people reported as losing access`)
        .toEqual(changes(opts.before, model.accesses()));
  };

  for (let [index, step] of steps.entries()) {
    let label = `step ${index}`;
    switch (step.kind) {
      case "invite": {
        let actor = pick(sharers(), step.actor)!, target = PEOPLE[step.target];
        if (actor === target) break;
        label += `: ${actor} invites ${target} to ${describeGrant(step.grant)}`;
        let info = mgr.addCollaborator({ caller: caller(actor), profile: profile(target), grant: step.grant });
        model.invite(target, actor, modelGrant(step.grant));
        expect(info.access, `${label}: access reported for ${target}`).toEqual(model.access(target));
        break;
      }
      case "createLink": {
        let actor = pick(sharers(), step.actor)!;
        label += `: ${actor} creates link ${model.links.length} to ${describeGrant(step.grant)}`;
        let { key, linkId } = await mgr.createShareLink({ caller: caller(actor), grant: step.grant });
        model.links.push({ id: linkId, creator: actor, grant: modelGrant(step.grant), revoked: false, keys: [key] });
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
        let before = model.accesses();
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
        let before = model.accesses();
        let preview = reported(mgr.previewRemoveCollaborator(caller(actor), target));
        // The owner cuts every grant the target holds; anyone else, only their own invites.
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

    let expected = model.accesses();
    for (let id of PEOPLE.slice(1)) {
      expect(mgr.getEffectiveAccess(id), `${label}: ${id}'s access`).toEqual(expected.get(id));
    }
    expect(Object.fromEntries(mgr.listCollaborators().map(c => [c.profile.id, c.access])),
        `${label}: people with access`).toEqual(Object.fromEntries(expected));
    expect(mgr.listShareLinkRecords().map(l => l.id).toSorted(), `${label}: live links`)
        .toEqual(model.links.filter(l => !l.revoked).map(l => l.id).toSorted());
  }
}

describe("sharing graph property", () => {
  const grant = fc.oneof(
      fc.constant<CollaboratorGrant>("workspace"),
      fc.constantFrom(...SHARED_GADGETS).map((gadgetId): CollaboratorGrant => ({ gadgetId })));
  const person = fc.integer({ min: 1, max: 4 });
  const choice = fc.nat({ max: 15 });
  const keep = fc.nat({ max: (1 << PEOPLE.length) - 1 });
  // Grants outweigh removals, so people often hold several paths when one is cut.
  const step: fc.Arbitrary<Step> = fc.oneof(
    { arbitrary: fc.record({ kind: fc.constant("invite" as const), actor: choice, target: person, grant }), weight: 4 },
    { arbitrary: fc.record({ kind: fc.constant("createLink" as const), actor: choice, grant }), weight: 2 },
    { arbitrary: fc.record({ kind: fc.constant("copyLink" as const), choice }), weight: 1 },
    { arbitrary: fc.record({ kind: fc.constant("open" as const), person, link: choice, key: choice }), weight: 4 },
    { arbitrary: fc.record({ kind: fc.constant("revoke" as const), choice, keep }), weight: 1 },
    { arbitrary: fc.record({ kind: fc.constant("remove" as const), choice, keep }), weight: 1 },
  );

  // Indices into PEOPLE. The comments resolve each pick.
  const [ANA, BEN, CY] = [1, 2, 3];
  const examples: [Step[]][] = [
    // Removing a link's creator cuts off whoever joined through it. Re-adding them with one gadget
    // leaves those people cut off, since only "build" supports grants; re-adding them to the
    // workspace restores them.
    [[
      { kind: "invite", actor: 0, target: ANA, grant: "workspace" },  // owner
      { kind: "createLink", actor: 1, grant: "workspace" },  // ana
      { kind: "open", person: BEN, link: 0, key: 0 },
      { kind: "remove", choice: 0, keep: 0 },  // owner removes ana
      { kind: "invite", actor: 0, target: ANA, grant: { gadgetId: 1 } },
      { kind: "invite", actor: 0, target: ANA, grant: "workspace" },
    ]],
    // A collaborator withdraws their own invite: ana keeps the owner's grant of gadget 1, and cy,
    // who joined through ana's link, loses access, since ana no longer holds "build".
    [[
      { kind: "invite", actor: 0, target: ANA, grant: { gadgetId: 1 } },
      { kind: "invite", actor: 0, target: BEN, grant: "workspace" },
      { kind: "invite", actor: 1, target: ANA, grant: "workspace" },  // ben
      { kind: "createLink", actor: 1, grant: "workspace" },  // ana
      { kind: "open", person: CY, link: 0, key: 0 },
      { kind: "remove", choice: 3, keep: 0 },  // ben removes ana
    ]],
    // Revoking a link while keeping ben, who joined through it, also keeps cy, whom ben invited.
    [[
      { kind: "invite", actor: 0, target: ANA, grant: "workspace" },
      { kind: "createLink", actor: 1, grant: "workspace" },  // ana
      { kind: "open", person: BEN, link: 0, key: 0 },
      { kind: "invite", actor: 2, target: CY, grant: { gadgetId: 1 } },  // ben
      { kind: "revoke", choice: 0, keep: 1 << BEN },  // owner revokes link 0
    ]],
    // Neither a copied key nor the original lets anyone in once the link is revoked.
    [[
      { kind: "createLink", actor: 0, grant: { gadgetId: 1 } },
      { kind: "copyLink", choice: 0 },
      { kind: "open", person: ANA, link: 0, key: 1 },
      { kind: "revoke", choice: 0, keep: 0 },
      { kind: "open", person: BEN, link: 0, key: 1 },
      { kind: "open", person: ANA, link: 0, key: 0 },
    ]],
    // Keeping someone who lost one of two gadgets restores only that one, from the actor: when
    // the other gadget's path is cut later, they keep the restored one, and re-adding its sharer
    // brings the other back.
    [[
      { kind: "invite", actor: 0, target: ANA, grant: "workspace" },
      { kind: "invite", actor: 0, target: CY, grant: "workspace" },
      { kind: "invite", actor: 1, target: BEN, grant: { gadgetId: 2 } },  // ana
      { kind: "invite", actor: 2, target: BEN, grant: { gadgetId: 1 } },  // cy
      { kind: "remove", choice: 0, keep: 1 << BEN },  // owner removes ana, keeping ben
      { kind: "remove", choice: 1, keep: 0 },  // owner removes cy
      { kind: "invite", actor: 0, target: CY, grant: "workspace" },
    ]],
  ];

  it("gives each person the access the grants still reachable from the owner allow", async () => {
    await fc.assert(
        fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 30, size: "medium" }), replaySharing),
        { ...PROPERTY_RUN_OPTIONS, numRuns: 200, examples });
  });
});

describe("migrateToFrozenGadgetGrants", () => {
  function makeMigrationManager(gadgetIds: WorkpieceId[]) {
    let raw = makeMockStorage();
    let storage = makeOverseerStorage(raw);
    storage.version.put(6);
    for (let id of gadgetIds) {
      storage.gadgets.put({
        type: "gadget", id, title: `Gadget ${id}`, created: new Date(), bindings: {},
      });
    }
    let gadgets = new Set(gadgetIds);
    let mgr = new SharingManager(storage, OWNER, () => false, id => gadgets.has(id));
    // Only storage, transactions and logging are used by this synchronous migration.
    let host = {
      storage, ctx: {storage: raw}, logger: createWorkshopLogger("test.sharing-migration"),
    } as OverseerMigrationHost;
    return {storage, gadgets, mgr, host};
  }

  it("splits each grant of every gadget into one edge per gadget, keeping who gave it", () => {
    let { storage, gadgets, mgr, host } = makeMigrationManager([2, 1]);
    let direct = { ...userEdge(OWNER, "use"), note: "trip" };
    seedCollaborator(storage, "builder", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "a", [direct, gadgetEdge(OWNER, 2)]);
    seedCollaborator(storage, "b", [userEdge("builder", "use")]);

    migrateToFrozenGadgetGrants(host);

    expect(edgesOf(storage, "a")).toEqual([
      { ...direct, gadgetId: 1 },
      { ...direct, gadgetId: 2 },
      expect.objectContaining({ sharer: OWNER, gadgetId: 2 }),
    ]);
    expect(edgesOf(storage, "b")).toEqual([
      expect.objectContaining({ sharer: "builder", role: "use", gadgetId: 1 }),
      expect.objectContaining({ sharer: "builder", role: "use", gadgetId: 2 }),
    ]);
    expect(edgesOf(storage, "builder")).toEqual([expect.objectContaining({ role: "build" })]);
    expect(storage.version.get()).toBe(7);
    // A gadget published afterwards is shared with no one.
    gadgets.add(3);
    expect(mgr.getEffectiveAccess("a")).toEqual(only(1, 2));
    expect(mgr.getEffectiveAccess("b")).toEqual(only(1, 2));
    expect(mgr.getEffectiveAccess("builder")).toEqual(BUILD);
  });

  it("freezes grants that confer nothing yet, so a sharer regaining build restores only those",
      () => {
    let { storage, gadgets, mgr, host } = makeMigrationManager([1, 2]);
    // a was narrowed from build to one gadget, leaving b's grant from a inert.
    seedCollaborator(storage, "a", [gadgetEdge(OWNER, 1)]);
    seedCollaborator(storage, "b", [userEdge("a", "use")]);
    seedLink(storage, "inactive-link", "a", "use");
    seedCollaborator(storage, "c", [keyEdge("inactive-link", "use")]);

    migrateToFrozenGadgetGrants(host);
    gadgets.add(3);
    mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: "workspace" });

    expect(mgr.getEffectiveAccess("b")).toEqual(only(1, 2));
    expect(link(storage, "inactive-link")).toMatchObject({gadgetIds: [1, 2]});
    expect(mgr.getEffectiveAccess("c")).toEqual(only(1, 2));
  });

  it("freezes a link to every gadget to those gadgets, and its keys still redeem", async () => {
    let { storage, gadgets, mgr, host } = makeMigrationManager([1, 2]);
    let { key, linkId } = await mgr.createShareLink({ caller: owner, grant: "workspace" });
    let { key: copy } = await mgr.newShareLinkKey({ caller: owner, linkId });
    // As stored before schema version 7.
    let original = { ...link(storage, linkId), role: "use" as const, note: "trip" };
    storage.shareKeys.put(original);
    let edge = { ...keyEdge(linkId, "use"), note: "redeemed" };
    seedCollaborator(storage, "a", [edge]);

    migrateToFrozenGadgetGrants(host);

    expect(link(storage, linkId)).toEqual({ ...original, gadgetIds: [1, 2] });
    expect(edgesOf(storage, "a")).toEqual([
      { ...edge, gadgetId: 1 },
      { ...edge, gadgetId: 2 },
    ]);
    gadgets.add(3);
    expect(mgr.getEffectiveAccess("a")).toEqual(only(1, 2));
    for (let [rawKey, profileId] of [[key, "b"], [copy, "c"]]) {
      await mgr.redeemShareKey({ rawKey, profileId, fetchProfile: async () => profile(profileId) });
      expect(mgr.getEffectiveAccess(profileId)).toEqual(only(1, 2));
    }
  });

  it("freezes a link to every gadget of a one-gadget workspace to an ordinary gadget link", () => {
    let { storage, host } = makeMigrationManager([5]);
    seedLink(storage, "k1", OWNER, "use");

    migrateToFrozenGadgetGrants(host);

    expect(link(storage, "k1")).toMatchObject({ role: "use", gadgetId: 5 });
    expect(link(storage, "k1")).not.toHaveProperty("gadgetIds");
  });

  it("revokes a link to every gadget of a workspace with none, dropping its grants", async () => {
    let { storage, gadgets, mgr, host } = makeMigrationManager([]);
    let { key, linkId } = await mgr.createShareLink({ caller: owner, grant: "workspace" });
    let { key: copy } = await mgr.newShareLinkKey({ caller: owner, linkId });
    storage.shareKeys.put({ ...link(storage, linkId), role: "use" });
    seedCollaborator(storage, "a", [keyEdge(linkId, "use"), userEdge(OWNER, "use")]);

    migrateToFrozenGadgetGrants(host);

    expect(link(storage, linkId).revoked).toBe(true);
    expect([...storage.shareKeys.list()].map(r => r.id)).toEqual([linkId]);
    expect(edgesOf(storage, "a")).toEqual([]);
    gadgets.add(1);
    for (let rawKey of [key, copy]) {
      await mgr.redeemShareKey({ rawKey, profileId: "b", fetchProfile: async () => profile("b") });
    }
    expect(storage.collaborators.get("b")).toBeUndefined();
    expect(mgr.getEffectiveAccess("a")).toBeUndefined();
  });

  it("leaves newer schemas unchanged, so later gadgets do not expand frozen grants", () => {
    let { storage, host } = makeMigrationManager([1]);
    seedLink(storage, "k1", OWNER, "use");
    migrateToFrozenGadgetGrants(host);
    storage.gadgets.put({
      type: "gadget", id: 2, title: "Later", created: new Date(), bindings: {},
    });

    migrateToFrozenGadgetGrants(host);

    expect(link(storage, "k1")).toMatchObject({gadgetId: 1});
    expect(link(storage, "k1")).not.toHaveProperty("gadgetIds");
    expect(storage.version.get()).toBe(7);
  });

  it("does not touch an earlier or never-initialized schema", () => {
    for (let version of [0, 5]) {
      let { storage, host } = makeMigrationManager([1]);
      storage.version.put(version);
      seedLink(storage, "k1", OWNER, "use");
      let original = link(storage, "k1");

      migrateToFrozenGadgetGrants(host);

      expect(link(storage, "k1")).toEqual(original);
      expect(storage.version.get()).toBe(version);
    }
  });

  it("excludes provisional gadgets and worktrees", () => {
    let { storage, host } = makeMigrationManager([1, 2]);
    storage.gadgets.put({...storage.gadgets.get(2)!, pending: {chatId: 10}});
    storage.gadgets.put({
      type: "worktree", id: 3, title: "Worktree", created: new Date(), chatId: 10,
      baseCommit: "base", headCommit: "base", pinBase: "base",
    });
    seedLink(storage, "k1", OWNER, "use");
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);

    migrateToFrozenGadgetGrants(host);

    expect(link(storage, "k1")).toMatchObject({gadgetId: 1});
    expect(link(storage, "k1")).not.toHaveProperty("gadgetIds");
    expect(edgesOf(storage, "a")).toEqual([
      expect.objectContaining({gadgetId: 1}),
    ]);
  });

  it("rolls back converted links and edges if the version stamp fails, then retries atomically", () => {
    let { storage, host } = makeMigrationManager([1, 2]);
    seedLink(storage, "k1", OWNER, "use");
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    let originalLink = link(storage, "k1");
    let originalEdges = edgesOf(storage, "a");
    let stamp = vi.spyOn(storage.version, "put").mockImplementationOnce(() => {
      throw new Error("interrupted migration");
    });

    expect(() => migrateToFrozenGadgetGrants(host)).toThrow("interrupted migration");

    expect(storage.version.get()).toBe(6);
    expect(link(storage, "k1")).toEqual(originalLink);
    expect(edgesOf(storage, "a")).toEqual(originalEdges);
    stamp.mockRestore();
    migrateToFrozenGadgetGrants(host);
    expect(storage.version.get()).toBe(7);
    expect(link(storage, "k1")).toEqual({...originalLink, gadgetIds: [1, 2]});
    expect(edgesOf(storage, "a")).toEqual([
      {...originalEdges[0], gadgetId: 1}, {...originalEdges[0], gadgetId: 2},
    ]);
  });

  it("lets each migrated gadget grant be removed independently", () => {
    let { storage, mgr, host } = makeMigrationManager([1, 2]);
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);

    migrateToFrozenGadgetGrants(host);
    mgr.removeCollaborator(owner, "a", [], 1);

    expect(mgr.getEffectiveAccess("a")).toEqual(only(2));
    expect(edgesOf(storage, "a")).toEqual([expect.objectContaining({gadgetId: 2})]);
    mgr.removeCollaborator(owner, "a", [], 2);
    expect(mgr.getEffectiveAccess("a")).toBeUndefined();
  });
});
