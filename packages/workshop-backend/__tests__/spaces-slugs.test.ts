// Slugs: the address a space gives each workspace it lists. SpaceModel's rules over a Map-backed
// storage, then one pass through a real Durable Object. The rest of the listing's rules are in
// spaces.test.ts.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { collection, createTypedStorage } from "@gadgets/typed-storage";
import { slugify, type AiChatAuthorInfo, type SpaceWorkspaceInfo } from "@gadgets/workshop-shared/api";
import { SpaceModel, teamSpaceClaim, type SpaceDurableObject } from "../src/spaces.js";
import { DEFAULT_WORKSPACE_TITLE } from "../src/storage-schema/overseer-storage.js";
import { makeSpaceStorage } from "../src/storage-schema/space-storage.js";
import type { UserDurableObject } from "../src/user.js";
import { makeMockStorage } from "./mock-storage.js";
// Load the whole backend up front, so that its slow load is not billed to the first test.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_SPACE: DurableObjectNamespace<SpaceDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const NO_SUCH_SPACE = "No such space, or you are not a member of it.";
const SLUG_IN_USE = "Another workspace of this space already uses that slug.";
const CREATED = new Date("2026-01-01");

const profile = (id: string): AiChatAuthorInfo => ({ type: "user", id, name: id });
// An admin, two ordinary members, and someone who is not a member.
const [ALICE, BOB, CAROL, DAVE] = ["alice", "bob", "carol", "dave"].map(profile);

// A team space over `raw`, with the members above.
function teamSpace(raw = makeMockStorage()) {
  let storage = makeSpaceStorage(raw);
  let model = new SpaceModel(storage);
  expect(model.claim(teamSpaceClaim("eng", "Engineering"), ALICE)).toBe(true);
  model.setMemberRole(ALICE.id, BOB, "build");
  model.setMemberRole(ALICE.id, CAROL, "use");
  return { model, storage };
}

const ws = (id: string, title: string) => ({ id, title, created: CREATED });
// The slug of every workspace the space lists, by id.
const slugs = (model: SpaceModel) =>
    Object.fromEntries(model.listWorkspaces(ALICE.id).map(w => [w.id, w.slug]));
// The workspace a slug leads a member to, and whether it is that workspace's current slug.
function resolve(model: SpaceModel, slug: string): string | null {
  let found = model.resolveWorkspace(ALICE.id, slug);
  return found && `${found.workspace.id}${found.canonical ? "" : " (former)"}`;
}

describe("SpaceModel slugs", () => {
  // The title a workspace is created with, and the one older workspaces still carry.
  it.each([DEFAULT_WORKSPACE_TITLE, "Untitled Gadget"])(
      "gives a workspace titled %j no slug, and one at its first title that is not a placeholder", placeholder => {
    let { model } = teamSpace();
    model.attachWorkspaces(BOB, [ws("a", placeholder)]);
    expect(model.listWorkspaces(ALICE.id)[0]).not.toHaveProperty("slug");
    expect(resolve(model, slugify(placeholder))).toBeNull();

    model.attachWorkspaces(BOB, [ws("a", "Q3 Roadmap: Café!")]);
    expect(model.listWorkspaces(ALICE.id)).toEqual(
        [{ id: "a", title: "Q3 Roadmap: Café!", owner: BOB, created: CREATED, slug: "q3-roadmap-cafe" }]);
  });

  it("derives \"workspace\" from a title with no letter or digit, and ends no cut slug in a dash", () => {
    let { model } = teamSpace();
    let cutAtDash = `${"x".repeat(79)} notes`;
    model.attachWorkspaces(BOB, [ws("a", "日本語のメモ"), ws("b", "!!!"), ws("c", cutAtDash)]);
    expect(slugs(model)).toEqual({ a: "workspace", b: "workspace-2", c: "x".repeat(79) });
  });

  it("never moves a slug when the title changes", () => {
    let { model } = teamSpace();
    model.attachWorkspaces(BOB, [ws("a", "Plan")]);
    for (let title of ["Roadmap", DEFAULT_WORKSPACE_TITLE]) {
      model.attachWorkspaces(BOB, [ws("a", title)]);
      expect(model.resolveWorkspace(ALICE.id, "plan")).toEqual({
        workspace: { id: "a", title, owner: BOB, created: CREATED, slug: "plan" }, canonical: true,
      });
    }
    expect(resolve(model, "roadmap")).toBeNull();
  });

  it("suffixes a derived slug that another workspace has", () => {
    let { model } = teamSpace();
    // Within one call and across calls, whoever the owners are.
    model.attachWorkspaces(BOB, [ws("a", "Plan"), ws("b", "plan!")]);
    model.attachWorkspaces(CAROL, [ws("c", "Plan"), ws("d", "Plan 2")]);
    expect(slugs(model)).toEqual({ a: "plan", b: "plan-2", c: "plan-3", d: "plan-2-2" });
  });

  it("never derives a slug that another workspace used to have", () => {
    let { model } = teamSpace();
    model.attachWorkspaces(BOB, [ws("a", "Plan")]);
    model.setWorkspaceSlug(BOB.id, "a", "roadmap");
    model.attachWorkspaces(CAROL, [ws("b", "Plan")]);
    expect(slugs(model)).toEqual({ a: "roadmap", b: "plan-2" });
    expect(resolve(model, "plan")).toBe("a (former)");
  });

  it("refuses an explicit slug that another workspace has now", () => {
    let { model } = teamSpace();
    model.attachWorkspaces(BOB, [ws("a", "Plan"), ws("b", "Notes")]);
    expect(() => model.setWorkspaceSlug(BOB.id, "b", "plan")).toThrow(SLUG_IN_USE);
    expect(() => model.setWorkspaceSlug(ALICE.id, "unlisted", "plan"))
        .toThrow("This space does not list that workspace.");
    expect(slugs(model)).toEqual({ a: "plan", b: "notes" });
    expect(resolve(model, "plan")).toBe("a");
  });

  it("cuts a derived slug so that its suffix fits, leaving one that can be asked for by name", () => {
    let { model } = teamSpace();
    // The longest slug a title leads to, with a dash where the cut for the suffix falls.
    let title = `${"x".repeat(77)} yy`;
    model.attachWorkspaces(BOB, [ws("a", title), ws("b", title)]);
    let cut = `${"x".repeat(77)}-2`;
    expect(slugs(model)).toEqual({ a: `${"x".repeat(77)}-yy`, b: cut });

    model.setWorkspaceSlug(BOB.id, "b", "short");
    expect(model.setWorkspaceSlug(BOB.id, "b", cut).slug).toBe(cut);
  });

  it("changes nothing when asked for the slug a workspace already has", () => {
    let { model, storage } = teamSpace();
    model.attachWorkspaces(BOB, [ws("a", "Plan")]);
    expect(model.setWorkspaceSlug(BOB.id, "a", "plan")).toMatchObject({ id: "a", slug: "plan" });
    expect(storage.workspaces.get("a")?.formerSlugs).toBeUndefined();
  });

  it("gives an explicit slug that another workspace only used to have, taking it from that one", () => {
    let { model, storage } = teamSpace();
    model.attachWorkspaces(BOB, [ws("a", "Plan"), ws("b", "Notes")]);
    model.setWorkspaceSlug(BOB.id, "a", "roadmap");
    expect(model.setWorkspaceSlug(BOB.id, "b", "plan")).toMatchObject({ id: "b", slug: "plan" });
    expect([resolve(model, "plan"), resolve(model, "notes"), resolve(model, "roadmap")])
        .toEqual(["b", "b (former)", "a"]);

    // The slug is no longer among the first one's former slugs: once given up again it leads to
    // the workspace that gave it up last.
    expect(storage.workspaces.get("a")?.formerSlugs).toEqual([]);
    model.setWorkspaceSlug(BOB.id, "b", "minutes");
    expect(resolve(model, "plan")).toBe("b (former)");
  });

  it.each(["", "Plan", "my plan", "-plan", "plan-", "my--plan", "café", "x".repeat(81)])(
      "refuses %j, which is not in slug form", slug => {
    let { model } = teamSpace();
    model.attachWorkspaces(BOB, [ws("a", "Plan"), ws("b", DEFAULT_WORKSPACE_TITLE)]);
    for (let id of ["a", "b"]) {
      expect(() => model.setWorkspaceSlug(BOB.id, id, slug)).toThrow(/^A slug is 1 to 80 lowercase/);
    }
    expect(slugs(model)).toEqual({ a: "plan", b: undefined });
  });

  it("gives a workspace that has no slug the one asked for, with no former slug", () => {
    let { model, storage } = teamSpace();
    model.attachWorkspaces(BOB, [ws("a", DEFAULT_WORKSPACE_TITLE)]);
    expect(model.setWorkspaceSlug(BOB.id, "a", "x".repeat(80)).slug).toBe("x".repeat(80));
    expect(storage.workspaces.get("a")?.formerSlugs).toEqual([]);
    // A title that comes later does not replace the slug it was given.
    model.attachWorkspaces(BOB, [ws("a", "Plan")]);
    expect(slugs(model)).toEqual({ a: "x".repeat(80) });
  });

  it("keeps resolving a former slug, not canonically, until it is the workspace's again", () => {
    let { model, storage } = teamSpace();
    model.attachWorkspaces(BOB, [ws("a", "Plan")]);
    model.setWorkspaceSlug(BOB.id, "a", "roadmap");
    // A title that comes after the rename leaves the former slug with the entry, as it does the slug.
    model.attachWorkspaces(BOB, [ws("a", "Retitled")]);
    expect(model.resolveWorkspace(ALICE.id, "plan")).toEqual({
      workspace: { id: "a", title: "Retitled", owner: BOB, created: CREATED, slug: "roadmap" },
      canonical: false,
    });

    model.setWorkspaceSlug(BOB.id, "a", "plan");
    expect([resolve(model, "plan"), resolve(model, "roadmap")]).toEqual(["a", "a (former)"]);
    expect(storage.workspaces.get("a")?.formerSlugs).toEqual(["roadmap"]);
  });

  it("keeps a workspace's 32 most recent former slugs, and frees the ones before", () => {
    let { model, storage } = teamSpace();
    model.attachWorkspaces(BOB, [ws("a", "v0")]);
    for (let n = 1; n <= 34; n++) model.setWorkspaceSlug(BOB.id, "a", `v${n}`);
    expect(storage.workspaces.get("a")?.formerSlugs)
        .toEqual(Array.from({ length: 32 }, (_, i) => `v${i + 2}`));
    expect(["v34", "v33", "v2", "v1", "v0"].map(slug => resolve(model, slug)))
        .toEqual(["a", "a (former)", "a (former)", null, null]);

    model.attachWorkspaces(CAROL, [ws("b", "v1"), ws("c", "v2")]);
    expect(slugs(model)).toMatchObject({ b: "v1", c: "v2-2" });
  });

  it("lets the owner a workspace is listed under and an admin change its slug, and nobody else", () => {
    let { model } = teamSpace();
    model.attachWorkspaces(BOB, [ws("a", "Plan")]);
    expect(model.setWorkspaceSlug(BOB.id, "a", "by-owner").slug).toBe("by-owner");
    expect(model.setWorkspaceSlug(ALICE.id, "a", "by-admin").slug).toBe("by-admin");
    expect(() => model.setWorkspaceSlug(CAROL.id, "a", "by-member"))
        .toThrow("Only a workspace's owner or an admin of this space can change its slug.");
    // Someone who is not a member gets the usual refusal, whether or not the workspace is listed.
    for (let id of ["a", "unlisted"]) {
      expect(() => model.setWorkspaceSlug(DAVE.id, id, "by-stranger")).toThrow(NO_SUCH_SPACE);
    }

    // Both are looked up at the time of the call: an owner who has left is a stranger, and a
    // member made admin since may.
    model.removeMember(ALICE.id, BOB.id);
    expect(() => model.setWorkspaceSlug(BOB.id, "a", "after-leaving")).toThrow(NO_SUCH_SPACE);
    model.setMemberRole(ALICE.id, CAROL, "admin");
    expect(model.setWorkspaceSlug(CAROL.id, "a", "by-new-admin").slug).toBe("by-new-admin");
    expect(slugs(model)).toEqual({ a: "by-new-admin" });
  });

  it("resolves a slug for members only", () => {
    let { model } = teamSpace();
    model.attachWorkspaces(BOB, [ws("a", "Plan")]);
    expect(model.resolveWorkspace(CAROL.id, "plan")).toMatchObject({ workspace: { id: "a" } });
    expect(model.resolveWorkspace(CAROL.id, "nothing-here")).toBeNull();
    for (let slug of ["plan", "nothing-here"]) {
      expect(() => model.resolveWorkspace(DAVE.id, slug)).toThrow(NO_SUCH_SPACE);
    }
  });

  it("frees a detached workspace's slug and former slugs", () => {
    let { model } = teamSpace();
    model.attachWorkspaces(BOB, [ws("a", "Plan")]);
    model.setWorkspaceSlug(BOB.id, "a", "roadmap");
    model.detachWorkspace("a", BOB.id);
    expect([resolve(model, "plan"), resolve(model, "roadmap")]).toEqual([null, null]);

    // Both go to whichever workspaces come to derive them, the one that left included.
    model.attachWorkspaces(CAROL, [ws("b", "Plan"), ws("c", "Roadmap")]);
    model.attachWorkspaces(BOB, [ws("a", "Plan")]);
    expect(slugs(model)).toEqual({ a: "plan-2", b: "plan", c: "roadmap" });
  });

  it("reads, lists and gives a slug to an entry stored before entries had slugs", () => {
    let raw = makeMockStorage();
    // The listing as it was declared then: no slug on an entry, and no index.
    let before = createTypedStorage(raw, {
      collections: { workspaces: collection<SpaceWorkspaceInfo>()({ primaryKey: "id" }) },
    });
    let { model } = teamSpace(raw);
    let old = { id: "old", title: "Plan", owner: BOB, created: CREATED };
    before.workspaces.put(old);
    before.workspaces.put({ ...old, id: "gone" });

    expect(model.listWorkspaces(ALICE.id).find(w => w.id === "old")).toEqual(old);
    expect(resolve(model, "plan")).toBeNull();
    // Dropped like any other, and renamed like any other that has no slug.
    model.detachWorkspace("gone", BOB.id);
    expect(model.setWorkspaceSlug(BOB.id, "old", "roadmap")).toEqual({ ...old, slug: "roadmap" });

    // One that is next written with the title it already had gets its slug then.
    before.workspaces.put({ ...old, id: "older" });
    model.attachWorkspaces(BOB, [ws("older", "Plan")]);
    expect(slugs(model)).toEqual({ old: "roadmap", older: "plan" });
  });

  it("never shows a member the former slugs", () => {
    let { model, storage } = teamSpace();
    model.attachWorkspaces(BOB, [ws("a", "Plan")]);
    let entry = { id: "a", title: "Plan", owner: BOB, created: CREATED, slug: "roadmap" };
    let renamed = model.setWorkspaceSlug(BOB.id, "a", "roadmap");
    expect(storage.workspaces.get("a")).toEqual({ ...entry, formerSlugs: ["plan"] });
    let shown = [
      renamed, ...model.listWorkspaces(CAROL.id), model.resolveWorkspace(CAROL.id, "plan")!.workspace,
    ];
    for (let workspace of shown) {
      expect(Object.keys(workspace).toSorted()).toEqual(Object.keys(entry).toSorted());
    }
  });
});

describe("SpaceDurableObject slugs", () => {
  it("renames and resolves through a member's capability, over a Durable Object's storage", async () => {
    let id = `erin-${crypto.randomUUID().slice(0, 8)}`;
    await env.TEST_USER.getByName(id).authenticateFromCfAccess(id, true);
    let erin = profile(id);
    let key = `team-${crypto.randomUUID().slice(0, 8)}`;
    let stub = env.TEST_SPACE.getByName(key);
    expect(await stub.claim(teamSpaceClaim(key, "Team"), erin)).toBe(true);
    expect(await stub.attachWorkspaces(erin, [ws("a", "Plan"), ws("b", "Plan")])).toBe(true);
    using space = (await stub.open(erin.id))!;

    let entry = { id: "a", title: "Plan", owner: erin, created: CREATED, slug: "roadmap" };
    expect(await space.setWorkspaceSlug("a", "roadmap")).toEqual(entry);
    expect(await space.setWorkspaceSlug("b", "plan-3")).toMatchObject({ id: "b", slug: "plan-3" });
    // The second takes over the first one's former slug, and its own stays a former one.
    expect(await space.setWorkspaceSlug("b", "plan")).toMatchObject({ id: "b", slug: "plan" });
    expect(await space.resolveWorkspace("roadmap")).toEqual({ workspace: entry, canonical: true });
    expect(await space.resolveWorkspace("plan-2")).toMatchObject({ workspace: { id: "b" }, canonical: false });
    expect(await space.resolveWorkspace("nothing-here")).toBeNull();
    expect((await space.listWorkspaces()).map(w => [w.id, w.slug]).toSorted())
        .toEqual([["a", "roadmap"], ["b", "plan"]]);

    await stub.detachWorkspace("b", erin.id);
    expect(await space.resolveWorkspace("plan")).toBeNull();
    expect(await space.resolveWorkspace("plan-2")).toBeNull();
  });
});
