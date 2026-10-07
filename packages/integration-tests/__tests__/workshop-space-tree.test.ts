// The tree of a space's listing end to end over the real RPC API: where a workspace created under
// a parent lands once the space lists it, who moves an entry and how an anchor places it, what
// becomes of the entries under one that is deleted, and what someone who is not a member sees of
// the tree.
//
// Every test builds its tree in a fresh team space of Alice's, one workspace at a time: each is
// given its first activity and then polled for, for a bounded time, until the space lists it
// (`listedWorkspace`), since that listing follows a sync its owner's account runs apart from the
// call that caused it. A move, a deletion and a change of publication are finished when their
// call returns, so after those the listing is read back directly.

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  slugify, type AuthenticatedApi, type Space, type SpaceWorkspaceInfo,
} from "@gadgets/workshop-shared/api";
import { type Harness, startTestGatekeeperHarness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, waitFor } from "../src/rpc-client.js";

let harness: Harness | undefined;
const network = new NetworkInterceptor();

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness();
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

function requireHarness(): Harness {
  if (harness === undefined) throw new Error("Workshop harness did not start");
  return harness;
}

// The refusals the tests tell apart, matched loosely so they follow the meaning, not the wording.
const NOT_OWNER_OR_ADMIN = /owner or an admin/i;
const NO_PARENT = /no such parent workspace/i;
const UNDER_ITSELF = /cannot be moved under itself/i;
const NOT_LISTED = /does not list that workspace/i;

/**
 * Alice, Bob, Carol and Dave, each signed up on a session of their own, and a team space of
 * Alice's, who administers it, with Bob in it to build and Carol to use. Dave is in no space of
 * Alice's.
 */
async function team(stack: DisposableStack) {
  const [aliceName, bobName, carolName, daveName] = nextUsernames("alice", "bob", "carol", "dave");
  const account = async (name: string) =>
    stack.use(await signUp(stack.use(connect(requireHarness().url)), name));
  const alice = await account(aliceName);
  const bob = await account(bobName);
  const carol = await account(carolName);
  const dave = await account(daveName);
  // Unique for the harness's lifetime, as the usernames are. The dash is part of the key grammar.
  const key = `team-${aliceName}`;
  const space = stack.use(await alice.createSpace(key, "Crew"));
  await space.setMemberRole(bobName, "build");
  await space.setMemberRole(carolName, "use");
  return { aliceName, bobName, carolName, daveName, alice, bob, carol, dave, key, space };
}

/**
 * A workspace of `owner`'s in team space `key` under `title`, created under `parentId` if one is
 * given, once `space` lists it: after its first activity, which a chat that starts no agent is
 * the cheapest thing to count as, and polled for, for a bounded time.
 */
async function listedWorkspace(
    stack: DisposableStack, owner: RpcStub<AuthenticatedApi>, key: string, space: RpcStub<Space>,
    title: string, parentId?: string) {
  const workspace = stack.use(await owner.newGadget(key, parentId));
  const { id } = await workspace.getMetadata();
  await workspace.setTitle(title);
  await workspace.newChat("Seen activity, with no agent", null);
  const entry = await listedAs(space, id, title);
  return { workspace, id, entry };
}

/** Polls, for a bounded time, until `space` lists workspace `id` under `title`. */
const listedAs = (space: RpcStub<Space>, id: string, title: string) =>
  waitFor(`workspace "${title}" in the space's listing`, async () => {
    const entry = (await space.listWorkspaces()).find(workspace => workspace.id === id);
    return entry?.title === title ? entry : null;
  });

/** The message `call` is refused with. Fails if it succeeds, releasing a stub it produced. */
async function refusal(call: PromiseLike<unknown>): Promise<string> {
  let result: unknown;
  try {
    result = await call;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  (result as Partial<Disposable> | null | undefined)?.[Symbol.dispose]?.();
  throw new Error("Expected the call to be refused");
}

/**
 * A listing in its order, each entry as the path of titles down to it, each title with the
 * entry's position. A path is built from the parent's, which the listing must have given first,
 * so a parent listed after its child shows as "?".
 */
function outlineOf(listing: SpaceWorkspaceInfo[]): string[] {
  const paths = new Map<string, string>();
  return listing.map(({ id, title, parentId, position }) => {
    const step = `${title}:${position}`;
    const path = parentId === undefined ? step : `${paths.get(parentId) ?? "?"}/${step}`;
    paths.set(id, path);
    return path;
  });
}

/** `space`'s listing, as `outlineOf` gives it. */
const outline = async (space: RpcStub<Space>) => outlineOf(await space.listWorkspaces());

it.concurrent("lists a workspace created under a parent there once it has seen activity, and at "
    + "the top when the space does not list that parent", async () => {
  using stack = new DisposableStack();
  const { alice, bob, carol, key, space } = await team(stack);
  // Carol, the member who owns none of these, is who reads the space.
  using listing = await carol.openSpace(key);

  const handbook = await listedWorkspace(stack, bob, key, listing, "Handbook");
  expect(handbook.entry).not.toHaveProperty("parentId");
  expect(handbook.entry.position).toBe(0);

  // Under it go a workspace of Bob's, then one of Alice's, each after the siblings before it.
  const onboarding =
      await listedWorkspace(stack, bob, key, listing, "Onboarding", handbook.id);
  expect(onboarding.entry).toMatchObject({ parentId: handbook.id, position: 0 });
  const benefits = await listedWorkspace(stack, alice, key, listing, "Benefits", handbook.id);
  expect(benefits.entry).toMatchObject({ parentId: handbook.id, position: 1 });

  // A parent the space does not list when the workspace first registers places it at the top:
  // here one that has seen no activity yet, and an id that names no workspace at all.
  using provisional = await bob.newGadget(key);
  const { id: provisionalId } = await provisional.getMetadata();
  await listedWorkspace(stack, bob, key, listing, "Stray", provisionalId);
  await listedWorkspace(stack, alice, key, listing, "Orphan", "no-such-workspace");

  // Parents come before their children, and siblings in their order.
  expect(await outline(listing)).toEqual([
    "Handbook:0", "Handbook:0/Onboarding:0", "Handbook:0/Benefits:1", "Stray:1", "Orphan:2",
  ]);
  // Every member sees the same tree.
  expect(await outline(space)).toEqual(await outline(listing));

  // A later registration, here of a new title, leaves the workspace where it was placed.
  await onboarding.workspace.setTitle("Onboarding, revised");
  expect(await listedAs(listing, onboarding.id, "Onboarding, revised"))
      .toEqual({ ...onboarding.entry, title: "Onboarding, revised" });
});

it.concurrent("moves a workspace as its owner or a space admin, before an anchor or at the end, "
    + "and refuses anyone else", async () => {
  using stack = new DisposableStack();
  const { bob, carol, dave, daveName, key, space } = await team(stack);
  using asBob = await bob.openSpace(key);
  using asCarol = await carol.openSpace(key);
  const a = await listedWorkspace(stack, bob, key, asBob, "A");
  const b = await listedWorkspace(stack, bob, key, asBob, "B");
  const c = await listedWorkspace(stack, bob, key, asBob, "C");
  expect(await outline(asBob)).toEqual(["A:0", "B:1", "C:2"]);

  // Bob, a plain member who owns them, puts C first, before A, then B under A, with no anchor.
  await asBob.moveWorkspace(c.id, null, a.id);
  expect(await outline(asBob)).toEqual(["C:0", "A:1", "B:2"]);
  await asBob.moveWorkspace(b.id, a.id);
  expect(await outline(asBob)).toEqual(["C:0", "A:1", "A:1/B:0"]);

  // Alice, who administers the space, moves A under C, and B comes along under A.
  await space.moveWorkspace(a.id, c.id);
  expect(await outline(space)).toEqual(["C:0", "C:0/A:0", "C:0/A:0/B:0"]);
  // An anchor that is not a sibling under the new parent puts the workspace at the end.
  await space.moveWorkspace(b.id, c.id, c.id);
  expect(await outline(space)).toEqual(["C:0", "C:0/A:0", "C:0/B:1"]);
  // And so does one that is the workspace itself.
  await space.moveWorkspace(a.id, c.id, a.id);
  const settled = ["C:0", "C:0/B:0", "C:0/A:1"];
  expect(await outline(space)).toEqual(settled);

  // Nothing moves under itself or a workspace below it, nor under one the space does not list,
  // and a workspace the space does not list moves nowhere.
  expect(await refusal(asBob.moveWorkspace(c.id, c.id))).toMatch(UNDER_ITSELF);
  expect(await refusal(asBob.moveWorkspace(c.id, a.id))).toMatch(UNDER_ITSELF);
  expect(await refusal(asBob.moveWorkspace(a.id, "no-such-workspace"))).toMatch(NO_PARENT);
  expect(await refusal(asBob.moveWorkspace("no-such-workspace", null))).toMatch(NOT_LISTED);

  // Carol, a member who does not own them, moves nothing.
  expect(await refusal(asCarol.moveWorkspace(a.id, null))).toMatch(NOT_OWNER_OR_ADMIN);
  expect(await refusal(asCarol.moveWorkspace(b.id, c.id, a.id))).toMatch(NOT_OWNER_OR_ADMIN);

  // Dave, once the published C opens the space to him, is refused as an unclaimed key is.
  const unclaimed = await refusal(dave.openSpace(`free-${daveName}`));
  await c.workspace.setPublicAccess("use");
  using visiting = await dave.openSpace(key);
  expect(await refusal(visiting.moveWorkspace(c.id, null, a.id))).toBe(unclaimed);
  expect(await refusal(visiting.moveWorkspace(a.id, null))).toBe(unclaimed);

  expect(await outline(space)).toEqual(settled);
});

it.concurrent("deleting a workspace moves the workspaces under it up into its place", async () => {
  using stack = new DisposableStack();
  const { alice, bob, key, space } = await team(stack);
  using asBob = await bob.openSpace(key);
  await listedWorkspace(stack, bob, key, asBob, "First");
  const parent = await listedWorkspace(stack, bob, key, asBob, "Parent");
  await listedWorkspace(stack, bob, key, asBob, "Last");
  const child = await listedWorkspace(stack, bob, key, asBob, "Child", parent.id);
  // A sibling of Alice's, which the space repositions as it does Bob's.
  await listedWorkspace(stack, alice, key, asBob, "Sibling", parent.id);
  await listedWorkspace(stack, bob, key, asBob, "Grandchild", child.id);
  expect(await outline(asBob)).toEqual([
    "First:0", "Parent:1", "Parent:1/Child:0", "Parent:1/Child:0/Grandchild:0",
    "Parent:1/Sibling:1", "Last:2",
  ]);

  // The children take Parent's place among its siblings, in their order, each with what was
  // under it.
  await parent.workspace.deleteSelf();
  const after = ["First:0", "Child:1", "Child:1/Grandchild:0", "Sibling:2", "Last:3"];
  expect(await outline(asBob)).toEqual(after);
  expect(await outline(space)).toEqual(after);
});

it.concurrent("someone who is not a member sees only the workspaces whose whole chain up the tree "
    + "is published, and resolves no other by slug", async () => {
  using stack = new DisposableStack();
  const { alice, dave, daveName, key, space } = await team(stack);
  // The tree, each workspace marked with whether it is published:
  //   F ─── G+
  //   A+ ── B+ ── C ── D+
  //      └─ E+
  const f = await listedWorkspace(stack, alice, key, space, "Foxtrot");
  const a = await listedWorkspace(stack, alice, key, space, "Alpha");
  const b = await listedWorkspace(stack, alice, key, space, "Bravo", a.id);
  const e = await listedWorkspace(stack, alice, key, space, "Echo", a.id);
  const c = await listedWorkspace(stack, alice, key, space, "Charlie", b.id);
  const d = await listedWorkspace(stack, alice, key, space, "Delta", c.id);
  const g = await listedWorkspace(stack, alice, key, space, "Golf", f.id);
  const unclaimed = await refusal(dave.openSpace(`free-${daveName}`));

  // A published workspace under an unpublished one opens nothing: the space has no published
  // workspace at its top, and so refuses Dave as a key nobody claimed.
  await g.workspace.setPublicAccess("use");
  expect(await refusal(dave.openSpace(key))).toBe(unclaimed);

  for (const { workspace } of [a, b, d, e]) await workspace.setPublicAccess("use");
  using visiting = await dave.openSpace(key);
  // Each shown entry is positioned among the siblings shown, so Alpha comes first with Foxtrot
  // hidden, and is otherwise as the members see it.
  const shown = await visiting.listWorkspaces();
  expect(outlineOf(shown)).toEqual(["Alpha:0", "Alpha:0/Bravo:0", "Alpha:0/Echo:1"]);
  expect(await outline(space)).toEqual([
    "Foxtrot:0", "Foxtrot:0/Golf:0", "Alpha:1", "Alpha:1/Bravo:0", "Alpha:1/Bravo:0/Charlie:0",
    "Alpha:1/Bravo:0/Charlie:0/Delta:0", "Alpha:1/Echo:1",
  ]);
  const membersSee = new Map((await space.listWorkspaces()).map(entry => [entry.id, entry]));
  for (const entry of shown) {
    expect(entry).toEqual({ ...membersSee.get(entry.id), position: entry.position });
  }

  // He resolves what he is shown, and nothing below an unpublished workspace, published or not,
  // under its slug or, given another, under the one it had.
  const resolvedId = async (slug: string) =>
    (await visiting.resolveWorkspace(slug))?.workspace.id ?? null;
  expect(await resolvedId(slugify("Bravo"))).toBe(b.id);
  for (const title of ["Charlie", "Delta", "Foxtrot", "Golf"]) {
    expect(await resolvedId(slugify(title)), title).toBeNull();
  }
  await space.setWorkspaceSlug(g.id, "golf-course");
  expect(await resolvedId("golf-course")).toBeNull();
  expect(await resolvedId(slugify("Golf"))).toBeNull();

  // Moved under a published workspace at the top, Golf is shown to him, under either slug.
  await space.moveWorkspace(g.id, a.id);
  expect(await outline(visiting))
      .toEqual(["Alpha:0", "Alpha:0/Bravo:0", "Alpha:0/Echo:1", "Alpha:0/Golf:2"]);
  expect(await visiting.resolveWorkspace(slugify("Golf")))
      .toMatchObject({ workspace: { id: g.id, slug: "golf-course" }, canonical: false });
  expect(await resolvedId("golf-course")).toBe(g.id);
});
