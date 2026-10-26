import { describe, it, expect } from "vitest";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import { SharingManager, SharingStorage, accessIncludesGadget } from "../src/sharing.js";
import type { CollaboratorRecord, ShareKeyRecord } from "../src/storage-schema/overseer-storage.js";
import {
  AiChatAuthorInfo, PermissionEdge, CollaboratorRole, CollaboratorAccess, WorkpieceId,
  getOpenWorkspaceErrorCode, OPEN_WORKSPACE_ERROR_CODES,
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
// Access to every gadget, held only through grants made before gadgets were shared individually.
const ALL: CollaboratorAccess = { role: "use", gadgetIds: "all" };
function only(...gadgetIds: WorkpieceId[]): CollaboratorAccess {
  return { role: "use", gadgetIds };
}

function profile(id: string): AiChatAuthorInfo {
  return { type: "user", id, name: id };
}

// A user edge. `role: "use"` without `gadgetId` is a legacy grant of every gadget.
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

// Read back a link record, asserting that the id names a link rather than one of its aliases.
function link(storage: SharingStorage, linkId: string) {
  let record = storage.shareKeys.get(linkId)!;
  if (record.alias !== undefined) throw new Error(`${linkId} is an alias, not a link`);
  return record;
}

// A redeemable link sharing every gadget, as created before gadgets were shared individually.
// Such links can no longer be made, so mint a link and rewrite it into the legacy shape.
async function legacyAllUseLink(storage: SharingStorage, mgr: SharingManager)
    : Promise<{ key: string; linkId: string }> {
  let result = await mgr.createShareLink({ caller: owner, grant: "build" });
  storage.shareKeys.put({ ...link(storage, result.linkId), role: "use" });
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
    seedCollaborator(storage, "legacy", [userEdge(OWNER, "use")]);
    seedCollaborator(storage, "builder", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "one", [gadgetEdge(OWNER, 2)]);
    expect(mgr.getEffectiveAccess("legacy")).toEqual(ALL);
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
  it("includes every id for build and legacy all-gadget access, else only the listed ones", () => {
    expect(accessIncludesGadget(BUILD, 99)).toBe(true);
    expect(accessIncludesGadget(ALL, 99)).toBe(true);
    expect(accessIncludesGadget(only(1, 3), 3)).toBe(true);
    expect(accessIncludesGadget(only(1, 3), 2)).toBe(false);
  });
});

describe("redeemShareKey", () => {
  it("creates a new collaborator (fetching profile) when the key is valid", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await mgr.createShareLink({ caller: owner, grant: "build" });

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
    let { key } = await mgr.createShareLink({ caller: owner, grant: "build" });

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

  it("gives a newcomer nothing through a legacy all-gadget link", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await legacyAllUseLink(storage, mgr);

    let fetched = 0;
    await mgr.redeemShareKey({
      rawKey: key, profileId: "newbie",
      fetchProfile: async () => { fetched++; return profile("newbie"); },
    });

    expect(fetched).toBe(0);
    expect(storage.collaborators.get("newbie")).toBeUndefined();
    expect(mgr.getEffectiveAccess("newbie")).toBeUndefined();
  });

  it("adds no edge to an existing collaborator through a legacy all-gadget link", async () => {
    let { storage, mgr } = makeManager();
    let { key } = await legacyAllUseLink(storage, mgr);
    seedCollaborator(storage, "a", [gadgetEdge(OWNER, 1)]);

    await mgr.redeemShareKey({ rawKey: key, profileId: "a", fetchProfile: async () => profile("a") });

    expect(edgesOf(storage, "a")).toEqual([expect.objectContaining({ type: "user", gadgetId: 1 })]);
    expect(mgr.getEffectiveAccess("a")).toEqual(only(1));
  });

  it("leaves an existing legacy link recipient's edge and access intact", async () => {
    let { storage, mgr } = makeManager();
    let { key, linkId } = await legacyAllUseLink(storage, mgr);
    let edge = keyEdge(linkId, "use");
    seedCollaborator(storage, "a", [edge]);

    await mgr.redeemShareKey({ rawKey: key, profileId: "a", fetchProfile: async () => profile("a") });

    expect(edgesOf(storage, "a")).toEqual([edge]);
    expect(mgr.getEffectiveAccess("a")).toEqual(ALL);
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
    let info = mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: "build", note: "hi" });
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
    expect(() => mgr.addCollaborator({ caller: owner, profile: profile(OWNER), grant: "build" }))
        .toThrow(/owner/);
  });

  it("refuses a grant of a gadget that cannot be shared", () => {
    let { storage, mgr } = makeManager();
    expect(() => mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: { gadgetId: 9 } }))
        .toThrow("No such gadget: 9");
    expect(storage.collaborators.get("a")).toBeUndefined();
  });

  it("forbids granting more access than the caller holds", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [gadgetEdge(OWNER, 1)]);
    expect(() => mgr.addCollaborator({ caller: collab("a"), profile: profile("b"), grant: "build" }))
        .toThrow("You cannot grant more access than you have.");
    // Holding gadget 1 says nothing about gadget 2.
    expect(() => mgr.addCollaborator({ caller: collab("a"), profile: profile("b"), grant: { gadgetId: 2 } }))
        .toThrow("You cannot grant more access than you have.");
    expect(storage.collaborators.get("b")).toBeUndefined();

    let info = mgr.addCollaborator({ caller: collab("a"), profile: profile("b"), grant: { gadgetId: 1 } });
    expect(info.access).toEqual(only(1));
  });

  it("lets a legacy all-gadget holder share any one gadget, but not build", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    expect(() => mgr.addCollaborator({ caller: collab("a"), profile: profile("b"), grant: "build" }))
        .toThrow("You cannot grant more access than you have.");
    mgr.addCollaborator({ caller: collab("a"), profile: profile("b"), grant: { gadgetId: 3 } });
    expect(mgr.getEffectiveAccess("b")).toEqual(only(3));
  });

  it("adds a second edge from a different sharer but dedups the same grant from one sharer", () => {
    let { storage, mgr } = makeManager();
    mgr.addCollaborator({ caller: owner, profile: profile("b"), grant: "build" });
    mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: "build" });
    mgr.addCollaborator({ caller: collab("b"), profile: profile("a"), grant: "build" });
    mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: "build", note: "again" });
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

    // A build grant from the same sharer covers them, so it replaces them with one edge.
    mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: "build" });
    expect(edgesOf(storage, "a")).toEqual([
      expect.objectContaining({ sharer: OWNER, role: "build" }),
    ]);
    expect(edgesOf(storage, "a")[0]).not.toHaveProperty("gadgetId");
    expect(mgr.getEffectiveAccess("a")).toEqual(BUILD);

    // Re-granting a gadget the build edge covers narrows nothing and adds no edge; only the note
    // changes.
    mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: { gadgetId: 1 }, note: "n" });
    expect(edgesOf(storage, "a")).toEqual([
      expect.objectContaining({ sharer: OWNER, role: "build", note: "n" }),
    ]);
    expect(mgr.getEffectiveAccess("a")).toEqual(BUILD);
  });

  it("treats a legacy all-gadget edge as covering gadget grants and covered by build", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "use"), userEdge("b", "build")]);
    seedCollaborator(storage, "b", [userEdge(OWNER, "build")]);

    mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: { gadgetId: 2 } });
    expect(edgesOf(storage, "a").filter(edge => edge.type === "user" && edge.sharer === OWNER))
        .toEqual([expect.objectContaining({ role: "use" })]);
    expect(edgesOf(storage, "a")[0]).not.toHaveProperty("gadgetId");

    // Build from the owner replaces the owner's legacy edge; b's edge is another sharer's.
    mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: "build" });
    expect(edgesOf(storage, "a")).toEqual([
      expect.objectContaining({ sharer: OWNER, role: "build" }),
      expect.objectContaining({ sharer: "b", role: "build" }),
    ]);
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

  it("bounds a grant by the sharer's effective access", () => {
    let { storage, mgr } = makeManager();
    // Old stored build edges from sharers that now hold less.
    seedCollaborator(storage, "legacy", [userEdge(OWNER, "use")]);
    seedCollaborator(storage, "one", [gadgetEdge(OWNER, 1)]);
    seedCollaborator(storage, "b", [userEdge("legacy", "build")]);
    seedCollaborator(storage, "c", [userEdge("one", "build")]);
    expect(mgr.getEffectiveAccess("b")).toEqual(ALL);
    expect(mgr.getEffectiveAccess("c")).toEqual(only(1));
  });

  it("never lets a sharer holding one gadget support a grant of another", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [gadgetEdge(OWNER, 1)]);
    // An old stored edge from a for gadget 2.
    seedCollaborator(storage, "b", [gadgetEdge("a", 2)]);
    seedCollaborator(storage, "c", [gadgetEdge("a", 2), gadgetEdge("a", 1)]);
    expect(mgr.getEffectiveAccess("b")).toBeUndefined();
    expect(mgr.getEffectiveAccess("c")).toEqual(only(1));
  });

  it("lets a legacy all-gadget holder support a grant of any one gadget", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "use")]);
    seedCollaborator(storage, "b", [gadgetEdge("a", 2)]);
    expect(mgr.getEffectiveAccess("b")).toEqual(only(2));
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

  it("keeps legacy all-gadget grants covering every gadget, including later ones, never build",
      () => {
    let { storage, gadgets, mgr } = makeManager({ gadgets: [1] });
    seedLink(storage, "k1", OWNER, "use");
    seedCollaborator(storage, "direct", [userEdge(OWNER, "use")]);
    seedCollaborator(storage, "linked", [keyEdge("k1", "use")]);
    // A gadget published after the grants were made.
    gadgets.add(42);

    for (let id of ["direct", "linked"]) {
      let access = mgr.getEffectiveAccess(id)!;
      expect(access).toEqual(ALL);
      expect(accessIncludesGadget(access, 42)).toBe(true);
    }
    // A build edge they hand on is still bounded below build.
    seedCollaborator(storage, "downstream", [userEdge("linked", "build")]);
    expect(mgr.getEffectiveAccess("downstream")).toEqual(ALL);
  });

  it("grants nothing through a cycle unreachable from the owner", () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "kb", "b", "build");
    seedCollaborator(storage, "a", [userEdge("b", "build"), keyEdge("kb")]);
    seedCollaborator(storage, "b", [userEdge("a", "build"), gadgetEdge("a", 1)]);
    expect(mgr.computeEffectiveAccess().size).toBe(0);
    expect(mgr.listCollaborators()).toEqual([]);

    // Rooting one member of the cycle brings the other in, bounded by that root.
    storage.collaborators.put({ profile: profile("a"), addedBy: [
      ...edgesOf(storage, "a"), gadgetEdge(OWNER, 2)] });
    expect(mgr.getEffectiveAccess("a")).toEqual(only(2));
    expect(mgr.getEffectiveAccess("b")).toEqual(only(2));
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

  it("uses the link's grant and creator, not the edge's stamped fields", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "creator", [gadgetEdge(OWNER, 1)]);
    seedLink(storage, "k1", "creator", "use", 1);
    // A forged edge claiming build through a gadget link grants only what the link does.
    seedCollaborator(storage, "a", [keyEdge("k1", "build")]);
    expect(mgr.getEffectiveAccess("a")).toEqual(only(1));
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

  it("re-adding a removed intermediary restores their downstream shares (undo)", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER)]);
    // a has shared with five users.
    for (let i = 0; i < 5; i++) seedCollaborator(storage, `d${i}`, [userEdge("a")]);

    mgr.removeCollaborator(owner, "a", []);
    expect(mgr.getEffectiveAccess("a")).toBeUndefined();
    for (let i = 0; i < 5; i++) expect(mgr.getEffectiveAccess(`d${i}`)).toBeUndefined();

    // Undo by re-adding a; the five downstream grants were never deleted.
    mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: "build" });
    expect(mgr.getEffectiveAccess("a")).toEqual(BUILD);
    for (let i = 0; i < 5; i++) expect(mgr.getEffectiveAccess(`d${i}`)).toEqual(BUILD);
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

  it("keeps a legacy all-gadget user's access without upgrading it", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [userEdge(OWNER, "build")]);
    seedCollaborator(storage, "b", [userEdge("a", "use")]);

    mgr.removeCollaborator(owner, "a", ["b"]);

    expect(mgr.getEffectiveAccess("b")).toEqual(ALL);
    let restored = edgesOf(storage, "b").find(e => e.type === "user" && e.sharer === OWNER)!;
    expect(restored.role).toBe("use");
    expect(restored.gadgetId).toBeUndefined();
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
    // c holds gadget 1 only through b.
    seedCollaborator(storage, "c", [gadgetEdge("b", 1)]);

    let affected = mgr.removeCollaborator(owner, "b", [], 1);

    expect(affected).toEqual([
      expect.objectContaining({ profile: profile("b"), oldAccess: only(1, 2), newAccess: only(2) }),
      expect.objectContaining({ profile: profile("c"), oldAccess: only(1), newAccess: null }),
    ]);
    // Every edge granting gadget 1 is severed, whoever gave it; the gadget 2 grant survives.
    expect(edgesOf(storage, "b")).toEqual([expect.objectContaining({ sharer: OWNER, gadgetId: 2 })]);
    expect(mgr.getEffectiveAccess("b")).toEqual(only(2));
    expect(mgr.getEffectiveAccess("a")).toEqual(BUILD);
  });

  it("does not sever build or legacy all-gadget edges when removing one gadget", () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "b", [userEdge(OWNER, "use"), gadgetEdge(OWNER, 1)]);
    let affected = mgr.removeCollaborator(owner, "b", [], 1);
    expect(affected).toEqual([]);
    expect(mgr.getEffectiveAccess("b")).toEqual(ALL);
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
    mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: "build" });
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

  it("revokes a legacy all-gadget link, keeping recipients only on request", () => {
    let { storage, mgr } = makeManager();
    seedLink(storage, "k1", OWNER, "use");
    seedCollaborator(storage, "a", [keyEdge("k1", "use")]);
    seedCollaborator(storage, "b", [keyEdge("k1", "use"), gadgetEdge(OWNER, 3)]);

    let affected = mgr.revokeShareLink(owner, "k1", ["b"]);
    expect(affected).toEqual([
      expect.objectContaining({ profile: profile("a"), oldAccess: ALL, newAccess: null }),
    ]);
    expect(mgr.getEffectiveAccess("a")).toBeUndefined();
    // b keeps all gadgets, still not build.
    expect(mgr.getEffectiveAccess("b")).toEqual(ALL);
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
    await mgr.createShareLink({ caller: owner, grant: "build" });
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

  it("forbids creating a link granting more access than the caller holds", async () => {
    let { storage, mgr } = makeManager();
    seedCollaborator(storage, "a", [gadgetEdge(OWNER, 1)]);
    await expect(mgr.createShareLink({ caller: collab("a"), grant: "build" }))
        .rejects.toThrow("You cannot grant more access than you have.");
    await expect(mgr.createShareLink({ caller: collab("a"), grant: { gadgetId: 2 } }))
        .rejects.toThrow("You cannot grant more access than you have.");
    expect(mgr.listShareLinkRecords()).toEqual([]);

    await mgr.createShareLink({ caller: collab("a"), grant: { gadgetId: 1 } });
    expect(mgr.listShareLinkRecords()).toHaveLength(1);
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
    let { key: key1, linkId } = await mgr.createShareLink({ caller: owner, grant: "build" });
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

  it("refuses to copy a legacy all-gadget link", async () => {
    let { storage, mgr } = makeManager();
    let { linkId } = await legacyAllUseLink(storage, mgr);
    await expect(mgr.newShareLinkKey({ caller: owner, linkId })).rejects.toThrow(/every gadget/);
    expect([...storage.shareKeys.list()].map(r => r.id)).toEqual([linkId]);
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

  it("forbids copying a link that now grants more than the caller holds", async () => {
    let { storage, mgr } = makeManager();
    // "a" created a build link and a gadget 2 link, then was narrowed to gadget 1.
    seedLink(storage, "k1", "a", "build");
    seedLink(storage, "k2", "a", "use", 2);
    seedCollaborator(storage, "a", [gadgetEdge(OWNER, 1)]);
    for (let linkId of ["k1", "k2"]) {
      await expect(mgr.newShareLinkKey({ caller: collab("a"), linkId }))
          .rejects.toThrow("You cannot grant more access than you have.");
    }
  });

  it("cannot manage a link through the id of one of its copies", async () => {
    let { storage, mgr } = makeManager();
    let { linkId } = await mgr.createShareLink({ caller: owner, grant: "build" });
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
    seedCollaborator(storage, "b", [userEdge(OWNER, "use")]);
    seedCollaborator(storage, "c", [gadgetEdge(OWNER, 3), gadgetEdge(OWNER, 1)]);
    let list = mgr.listCollaborators();
    expect(list.find(x => x.profile.id === "a")!.access).toEqual(BUILD);
    expect(list.find(x => x.profile.id === "b")!.access).toEqual(ALL);
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
    let { key } = await mgr.createShareLink({ caller: owner, grant: "build" });
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
    let { key } = await mgr.createShareLink({ caller: owner, grant: "build" });
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
    let { key, linkId } = await mgr.createShareLink({ caller: owner, grant: "build" });
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
    mgr.addCollaborator({ caller: owner, profile: profile("a"), grant: "build" });
    expect(mgr.getEffectiveAccess("a")).toEqual(BUILD);
    expect(mgr.getEffectiveAccess("b")).toBeUndefined();

    mgr.addCollaborator({ caller: owner, profile: profile("b"), grant: { gadgetId: 1 } });
    expect(mgr.getEffectiveAccess("b")).toEqual(only(1));
  });
});
