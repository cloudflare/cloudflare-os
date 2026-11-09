// Spaces end to end over the real RPC API: a user's personal space, team spaces and their ids,
// the member list as the one authority on who may open a space and change it, and the workspaces
// a space lists.
//
// A user's listing of their spaces is a record their own account keeps, which each space writes
// before the call that changed a membership returns. So these tests read it back directly, with
// no polling.
//
// A space's listing of workspaces is read back directly too after a move, which is finished when
// its call returns. A deletion is not: the deleted workspace has every account that holds a
// record of it drop the record, its owner's along with the listing, and asks again until each
// has. And a workspace's first activity and a change of its title reach the listing through a
// sync its owner's account runs apart from the call that caused it. So there, and only there, the
// tests poll with a bounded wait (`listedAs`, `unlisted`).
//
// The fixture gatekeeper is bound for the one thing it is the cheapest real way to do: record an
// observation marked as restricted data, or as owner-invites-only, through a session on one of
// its connections (`TestSession.readValue`).

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type {
  AuthenticatedApi, Space, SpaceInfo, SpaceMemberInfo,
} from "@gadgets/workshop-shared/api";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import { type Harness, startTestGatekeeperHarness, TEST_VENDOR_ID } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, logIn, nextUsernames, signUp, waitFor,
} from "../src/rpc-client.js";

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

function usernames(...prefixes: string[]): string[] {
  const values = nextUsernames(...prefixes);
  if (values.length !== prefixes.length) throw new Error("Failed to allocate test usernames");
  return values;
}

/** Sign a new account up on a session of its own; `stack` owns both. */
async function newAccount(stack: DisposableStack, username: string, displayName?: string)
    : Promise<RpcStub<AuthenticatedApi>> {
  const publicApi = stack.use(connect(requireHarness().url));
  return stack.use(await signUp(publicApi, username, displayName));
}

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

/** The caller's personal space: the first entry of their listing. */
async function personalSpaceOf(api: RpcStub<AuthenticatedApi>): Promise<SpaceInfo> {
  const [personal] = await api.listSpaces();
  if (personal === undefined) throw new Error("The listing held no personal space");
  expect(personal.kind).toBe("personal");
  return personal;
}

/** Space `id` as the caller's listing shows it, if it does. */
const listed = async (api: RpcStub<AuthenticatedApi>, id: string) =>
  (await api.listSpaces()).find(space => space.id === id);

// Member lists are compared as (id, role) pairs in id order, whatever order the space lists in.
const sorted = (...members: { id: string; role: string }[]) =>
  members.toSorted((a, b) => a.id.localeCompare(b.id));
const roles = (members: SpaceMemberInfo[]) =>
  sorted(...members.map(({ profile, role }) => ({ id: profile.id, role })));

// The refusals the tests tell apart, matched loosely so they follow the meaning, not the wording.
const INVALID_ID = /invalid space id/i;
const BAD_NAME = /1 to 100 characters/i;
const NOT_ADMIN = /only an admin/i;
const KEEPS_AN_ADMIN = /at least one admin/i;
const NOT_A_MEMBER = /not a member/i;
const NO_PERSONAL_MEMBERS = /a personal space has no members\./i;
const OWNER_ONLY = /only the workspace owner/i;

// Strings that are no space id: empty, a space's name, the wrong length, 64 digits that no
// namespace made, and a workspace's id, which is a well-formed id of another namespace.
const notIds = (workspaceId: string) =>
  ["", "eng", "Crew", "not-an-id", "0".repeat(64), "f".repeat(63), workspaceId];

/** The ids of the workspaces `space` lists, in its order. */
const workspaceIds = async (space: RpcStub<Space>) =>
  (await space.listWorkspaces()).map(({ id }) => id);

/** Polls, for a bounded time, until `space` lists workspace `id` under `title`. */
const listedAs = (space: RpcStub<Space>, id: string, title: string) =>
  waitFor(`workspace "${title}" in the space's listing`, async () => {
    const entry = (await space.listWorkspaces()).find(workspace => workspace.id === id);
    return entry?.title === title ? entry : null;
  });

/** Polls, for a bounded time, until `space` no longer lists workspace `id`. */
const unlisted = (space: RpcStub<Space>, id: string) =>
  waitFor(`workspace ${id} to leave the space's listing`, async () =>
    (await workspaceIds(space)).includes(id) ? null : true);

/** The caller's own record of workspace `id`, which never shows what a space acknowledged. */
async function ownRecord(api: RpcStub<AuthenticatedApi>, id: string) {
  const record = (await api.listWorkspaces()).find(gadget => gadget.id === id);
  if (record === undefined) throw new Error(`Workspace ${id} is not in its owner's list`);
  expect(record).not.toHaveProperty("registered");
  return record;
}

it.concurrent("lists the caller's personal space first, under one id from every session",
    async () => {
  const [aliceName] = usernames("alice");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName, "Alice Example");
  const second = stack.use(await logIn(stack.use(connect(requireHarness().url)), aliceName));

  // First use from two sessions at once: both land on the one space that is hers.
  const [first, concurrent] = await Promise.all([alice.listSpaces(), second.listSpaces()]);
  expect(first).toHaveLength(1);
  const personal = first[0];
  expect(personal).toMatchObject({
    kind: "personal",
    role: "admin",
    owner: { type: "user", id: aliceName, name: "Alice Example" },
  });
  expect(personal.id).toEqual(expect.any(String));
  expect(personal.id).not.toBe("");
  expect(concurrent).toEqual(first);
  expect(await alice.listSpaces()).toEqual(first);

  // A session opened after the space exists finds it under the same id.
  const later = stack.use(await logIn(stack.use(connect(requireHarness().url)), aliceName));
  expect(await later.listSpaces()).toEqual(first);

  using space = await later.openSpace(personal.id);
  expect(await space.getInfo()).toEqual(personal);
  const members = await space.listMembers();
  expect(roles(members)).toEqual([{ id: aliceName, role: "admin" }]);
  expect(members[0].added).toBeInstanceOf(Date);
});

it.concurrent("creates team spaces their creator lists as their admin", async () => {
  const [aliceName] = usernames("alice");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);

  using zulu = await alice.createSpace("  Zulu Crew  ");
  const zuluInfo = await zulu.getInfo();
  expect(zuluInfo).toEqual({
    id: expect.any(String), name: "Zulu Crew", kind: "team", role: "admin",
  });
  expect(zuluInfo.owner).toBeUndefined();
  expect(roles(await zulu.listMembers())).toEqual([{ id: aliceName, role: "admin" }]);

  using alpha = await alice.createSpace("Alpha Crew");
  const alphaInfo = await alpha.getInfo();
  expect(alphaInfo).toEqual({
    id: expect.any(String), name: "Alpha Crew", kind: "team", role: "admin",
  });

  // The personal space leads, then the others by name: Zulu Crew is the older of the two.
  const spaces = await alice.listSpaces();
  expect(spaces[0]).toMatchObject({ kind: "personal", owner: { id: aliceName } });
  expect(spaces.slice(1)).toEqual([alphaInfo, zuluInfo]);
  // Each space has an id of its own.
  expect(new Set(spaces.map(space => space.id)).size).toBe(3);
});

it.concurrent(
    "creates another space each time, whatever its name, and refuses a blank or over-long one",
    async () => {
  const [aliceName, bobName] = usernames("alice", "bob");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  const bob = await newAccount(stack, bobName);
  const personal = await personalSpaceOf(alice);

  // One name, three times over, from two accounts: three spaces, each its creator's alone.
  using first = await alice.createSpace("Twin");
  using second = await alice.createSpace("Twin");
  using bobs = await bob.createSpace("Twin");
  const [firstInfo, secondInfo, bobsInfo] =
      await Promise.all([first.getInfo(), second.getInfo(), bobs.getInfo()]);
  for (const info of [firstInfo, secondInfo, bobsInfo]) {
    expect(info).toEqual({ id: expect.any(String), name: "Twin", kind: "team", role: "admin" });
  }
  expect(new Set([firstInfo.id, secondInfo.id, bobsInfo.id]).size).toBe(3);
  expect(roles(await first.listMembers())).toEqual([{ id: aliceName, role: "admin" }]);
  expect(roles(await second.listMembers())).toEqual([{ id: aliceName, role: "admin" }]);
  expect(roles(await bobs.listMembers())).toEqual([{ id: bobName, role: "admin" }]);

  // Alice lists her personal space and both of her own, and Bob opens neither of them.
  const listing = await alice.listSpaces();
  expect(listing).toHaveLength(3);
  expect(listing[0]).toEqual(personal);
  expect(listing.slice(1)).toEqual(expect.arrayContaining([firstInfo, secondInfo]));
  expect(await refusal(bob.openSpace(firstInfo.id))).toMatch(NOT_A_MEMBER);
  expect(await refusal(bob.openSpace(secondInfo.id))).toMatch(NOT_A_MEMBER);

  // A name is trimmed before it is judged, and a refused name creates nothing.
  expect(await refusal(alice.createSpace("   "))).toMatch(BAD_NAME);
  expect(await refusal(alice.createSpace("n".repeat(10_000)))).toMatch(BAD_NAME);
  expect(await alice.listSpaces()).toEqual(listing);
});

it.concurrent(
    "refuses a space the caller is not in, another user's personal space and a string that is no id",
    async () => {
  const [aliceName, bobName] = usernames("alice", "bob");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  const bob = await newAccount(stack, bobName);
  using space = await alice.createSpace("Crew");
  const { id: spaceId } = await space.getInfo();
  const alicePersonal = await personalSpaceOf(alice);
  const bobPersonal = await personalSpaceOf(bob);
  expect(bobPersonal.id).not.toBe(alicePersonal.id);
  using workspace = await bob.newWorkspace();
  const { id: workspaceId } = await workspace.getMetadata();

  // Knowing an id opens nothing: both spaces answer Bob alike.
  const notAMember = await refusal(bob.openSpace(spaceId));
  expect(notAMember).toMatch(NOT_A_MEMBER);
  expect(await refusal(bob.openSpace(alicePersonal.id))).toBe(notAMember);

  // A string that is no space id gets one refusal of its own, whatever is wrong with it.
  const invalid = await refusal(bob.openSpace("not-an-id"));
  expect(invalid).toMatch(INVALID_ID);
  expect(invalid).not.toBe(notAMember);
  for (const bad of notIds(workspaceId)) {
    expect(await refusal(bob.openSpace(bad)), bad).toBe(invalid);
  }

  // An id is hexadecimal, and names its space in either case.
  using shouted = await alice.openSpace(spaceId.toUpperCase());
  expect((await shouted.getInfo()).id).toBe(spaceId);

  // Asking joined nothing.
  expect(await bob.listSpaces()).toEqual([bobPersonal]);
  expect(roles(await space.listMembers())).toEqual([{ id: aliceName, role: "admin" }]);
});

it.concurrent("a member's role and removal reach their listing and their open stub", async () => {
  const [aliceName, bobName, ghostName] = usernames("alice", "bob", "ghost");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  const bob = await newAccount(stack, bobName);
  using space = await alice.createSpace("Crew");
  const { id: spaceId } = await space.getInfo();
  const withBobAs = (role: string) => sorted({ id: aliceName, role: "admin" }, { id: bobName, role });

  // Nobody ever signed up as the ghost.
  expect(await space.setMemberRole(ghostName, "build")).toBeNull();

  // Bob is added before he has ever listed his spaces, so before his personal space exists: it
  // still leads his listing.
  const added = await space.setMemberRole(bobName, "build");
  if (added === null) throw new Error(`Failed to add ${bobName}`);
  expect(added).toMatchObject({ profile: { id: bobName }, role: "build" });
  const bobSpaces = await bob.listSpaces();
  expect(bobSpaces).toHaveLength(2);
  expect(bobSpaces[0]).toMatchObject({ kind: "personal", role: "admin", owner: { id: bobName } });
  expect(bobSpaces[1]).toEqual({ id: spaceId, name: "Crew", kind: "team", role: "build" });
  using bobSpace = await bob.openSpace(spaceId);
  expect(await bobSpace.getInfo()).toEqual(bobSpaces[1]);
  expect(roles(await bobSpace.listMembers())).toEqual(withBobAs("build"));

  // A member who is not an admin changes nobody, and the only admin does not step down.
  expect(await refusal(bobSpace.setMemberRole(bobName, "admin"))).toMatch(NOT_ADMIN);
  expect(await refusal(bobSpace.removeMember(aliceName))).toMatch(NOT_ADMIN);
  expect(await refusal(space.setMemberRole(aliceName, "build"))).toMatch(KEEPS_AN_ADMIN);
  expect(await refusal(space.removeMember(aliceName))).toMatch(KEEPS_AN_ADMIN);
  expect(roles(await space.listMembers())).toEqual(withBobAs("build"));

  // Lowering a role replaces it and keeps the date the member joined.
  expect(await space.setMemberRole(bobName, "use")).toEqual({ ...added, role: "use" });
  expect(roles(await space.listMembers())).toEqual(withBobAs("use"));
  expect(await listed(bob, spaceId)).toMatchObject({ role: "use" });

  // Removal reaches the stub Bob already holds, and leaves him where a stranger stands.
  await space.removeMember(bobName);
  const removed = await refusal(bobSpace.getInfo());
  expect(await bob.listSpaces()).toEqual([bobSpaces[0]]);
  expect(await refusal(bob.openSpace(spaceId))).toBe(removed);
  expect(roles(await space.listMembers())).toEqual([{ id: aliceName, role: "admin" }]);
});

it.concurrent("a personal space takes no members besides its owner", async () => {
  const [aliceName, bobName] = usernames("alice", "bob");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  const bob = await newAccount(stack, bobName);
  const personal = await personalSpaceOf(alice);
  using space = await alice.openSpace(personal.id);

  // Not another account in any role, nor the owner herself.
  for (const role of ["admin", "build", "use"] as const) {
    expect(await refusal(space.setMemberRole(bobName, role))).toMatch(NO_PERSONAL_MEMBERS);
    expect(await refusal(space.setMemberRole(aliceName, role))).toMatch(NO_PERSONAL_MEMBERS);
  }
  // The owner stays its one admin: she cannot leave it.
  expect(await refusal(space.removeMember(aliceName))).toMatch(KEEPS_AN_ADMIN);
  expect(roles(await space.listMembers())).toEqual([{ id: aliceName, role: "admin" }]);

  // Bob lists only his own personal space, and is no member of Alice's.
  const bobSpaces = await bob.listSpaces();
  expect(bobSpaces).toHaveLength(1);
  expect(bobSpaces[0]).toMatchObject({ kind: "personal", owner: { id: bobName }, role: "admin" });
  expect(await refusal(bob.openSpace(personal.id))).toMatch(NOT_A_MEMBER);
});

it.concurrent("a team space lists a member's workspace once it has seen activity, under its title",
    async () => {
  const [aliceName, bobName] = usernames("alice", "bob");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  const bob = await newAccount(stack, bobName, "Bob Example");
  using space = await alice.createSpace("Crew");
  const { id: spaceId } = await space.getInfo();
  await space.setMemberRole(bobName, "use");

  // Bob creates two workspaces in the space, and only the second goes on to see activity.
  using draft = await bob.newWorkspace(spaceId);
  await draft.setTitle("Draft");
  using workspace = await bob.newWorkspace(spaceId);
  const { id } = await workspace.getMetadata();
  await workspace.setTitle("Roadmap");
  expect(await space.listWorkspaces()).toEqual([]);

  // A chat that starts no agent is the cheapest thing that counts as activity.
  await workspace.newChat("Seen activity, with no agent", null);
  const entry = await listedAs(space, id, "Roadmap");
  const record = await ownRecord(bob, id);
  expect(record.spaceId).toBe(spaceId);
  expect(entry).toEqual({
    id, title: "Roadmap", created: record.created,
    owner: expect.objectContaining({ type: "user", id: bobName, name: "Bob Example" }),
  });
  // Bob's account syncs his workspaces one at a time, so by now it is past the draft's change of
  // title, which registered nothing.
  expect(await space.listWorkspaces()).toEqual([entry]);

  await workspace.setTitle("Revised");
  expect(await listedAs(space, id, "Revised")).toEqual({ ...entry, title: "Revised" });
});

it.concurrent("a workspace that holds restricted data or is owner-invites-only stays in the "
    + "listing, under its current title", async () => {
  const [aliceName, bobName] = usernames("alice", "bob");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  const bob = await newAccount(stack, bobName);
  using space = await alice.createSpace("Crew");
  const { id: spaceId } = await space.getInfo();
  await space.setMemberRole(bobName, "use");
  // The listing is read as Bob throughout: the member who owns none of the workspaces.
  using listing = await bob.openSpace(spaceId);
  const listedIds = async () => (await workspaceIds(listing)).toSorted();
  await alice.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = await waitFor("the fixture account to be provisioned", async () =>
    (await listConnectedAccounts(alice)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);

  // A workspace of Alice's in the space, and a session to observe through on a fixture connection
  // of its own.
  const titledWorkspace = async (title: string) => {
    const workspace = stack.use(await alice.newWorkspace(spaceId));
    const { id } = await workspace.getMetadata();
    await workspace.setTitle(title);
    using connection = await workspace.newGatekeeper(
        account.id, `https://gadgets-test.example/things/${id}`);
    if (connection === null) throw new Error("Failed to create the test connection");
    const session = stack.use(await connection.openSession() as RpcStub<TestSession>);
    return { id, workspace, session };
  };
  // One that the space lists before anything is observed through it.
  const listedWorkspace = async (title: string) => {
    const made = await titledWorkspace(title);
    await made.workspace.newChat("Seen activity, with no agent", null);
    await listedAs(listing, made.id, title);
    return made;
  };
  const restricted = await listedWorkspace("Plan");
  const invitesOnly = await listedWorkspace("Budget");
  const both = [restricted.id, invitesOnly.id].toSorted();

  // One observation marked as restricted data, the other as owner-invites-only and nothing else.
  expect(await restricted.session.readValue(true)).toBe(42);
  expect(await invitesOnly.session.readValue(false, true)).toBe(42);

  // A title given after the flag reaches the listing, which still holds both workspaces.
  await restricted.workspace.setTitle("Plan, from the data");
  await invitesOnly.workspace.setTitle("Budget, from the data");
  await listedAs(listing, restricted.id, "Plan, from the data");
  await listedAs(listing, invitesOnly.id, "Budget, from the data");
  expect(await listedIds()).toEqual(both);

  // A move its owner may make is carried out, out of the space and back.
  await restricted.workspace.moveToSpace(null);
  expect(await workspaceIds(listing)).toEqual([invitesOnly.id]);
  await restricted.workspace.moveToSpace(spaceId);
  expect(await listedIds()).toEqual(both);

  // A move its owner may not make is refused as it is for any workspace, and moves nothing.
  const bobPersonal = await personalSpaceOf(bob);
  expect(await refusal(invitesOnly.workspace.moveToSpace(bobPersonal.id))).toMatch(NOT_A_MEMBER);
  expect(await refusal(invitesOnly.workspace.moveToSpace("not-an-id"))).toMatch(INVALID_ID);
  expect((await ownRecord(alice, invitesOnly.id)).spaceId).toBe(spaceId);
  expect(await listedIds()).toEqual(both);

  // A workspace that holds both flags before it has seen any activity is listed once it has.
  const early = await titledWorkspace("Ledger");
  expect(await early.session.readValue(true, true)).toBe(42);
  await early.workspace.newChat("Seen activity, with no agent", null);
  await listedAs(listing, early.id, "Ledger");

  // Alice's own record of each says where it is and under which title, and neither flag: her
  // account is not told them. The workspace itself tells her, on a session of hers.
  const held = [
    { ...restricted, title: "Plan, from the data", flags: { containsRestrictedData: true } },
    { ...invitesOnly, title: "Budget, from the data", flags: { ownerInvitesOnly: true } },
    { ...early, title: "Ledger", flags: { containsRestrictedData: true, ownerInvitesOnly: true } },
  ];
  for (const { id, title, flags } of held) {
    const record = await ownRecord(alice, id);
    expect(record).toMatchObject({ title, spaceId });
    expect(record).not.toHaveProperty("containsRestrictedData");
    expect(record).not.toHaveProperty("ownerInvitesOnly");
    using reopened = await alice.openWorkspace(id);
    expect(await reopened.getMetadata()).toMatchObject({ id, ...flags });
  }
});

it.concurrent("only its owner moves a workspace, and only where they may add; deleting unlists it",
    async () => {
  const [aliceName, bobName, carolName] = usernames("alice", "bob", "carol");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  const bob = await newAccount(stack, bobName);
  const carol = await newAccount(stack, carolName);
  using aliceSpace = await alice.createSpace("Crew");
  const { id: spaceId } = await aliceSpace.getInfo();
  await aliceSpace.setMemberRole(bobName, "use");
  using other = await carol.createSpace("Other");
  const { id: otherId } = await other.getInfo();
  const carolPersonal = await personalSpaceOf(carol);
  using carolHome = await carol.openSpace(carolPersonal.id);
  // Bob's two spaces are read as Bob: his is the session his deleting the workspace leaves alone.
  const bobPersonal = await personalSpaceOf(bob);
  using team = await bob.openSpace(spaceId);
  using personal = await bob.openSpace(bobPersonal.id);

  using workspace = await bob.newWorkspace(spaceId);
  const { id } = await workspace.getMetadata();
  await workspace.setTitle("Tracker");
  await workspace.newChat("Seen activity, with no agent", null);
  await listedAs(team, id, "Tracker");

  // Alice administers the space and builds on the workspace; Carol, outside the space, builds on
  // it too and names a space of her own. Neither is the owner.
  await workspace.addCollaborator(aliceName, "workspace");
  await workspace.addCollaborator(carolName, "workspace");
  {
    using asAlice = await alice.openWorkspace(id);
    using asCarol = await carol.openWorkspace(id);
    expect(await refusal(asAlice.moveToSpace(null))).toMatch(OWNER_ONLY);
    expect(await refusal(asCarol.moveToSpace(otherId))).toMatch(OWNER_ONLY);
  }

  // The owner is refused a team space he is not in and another user's personal space alike, as
  // he is when he opens either.
  const notAMember = await refusal(workspace.moveToSpace(otherId));
  expect(notAMember).toMatch(NOT_A_MEMBER);
  expect(await refusal(workspace.moveToSpace(carolPersonal.id))).toBe(notAMember);
  expect(await refusal(bob.openSpace(otherId))).toBe(notAMember);

  // A string that is no space id is refused in the words opening a space by it is: one text,
  // from the server and from the owner's account behind the workspace.
  const invalid = await refusal(bob.openSpace("not-an-id"));
  expect(invalid).toMatch(INVALID_ID);
  expect(invalid).not.toBe(notAMember);
  for (const bad of notIds(id)) {
    expect(await refusal(workspace.moveToSpace(bad)), bad).toBe(invalid);
  }

  // Nothing moved.
  expect((await ownRecord(bob, id)).spaceId).toBe(spaceId);
  expect(await workspaceIds(team)).toEqual([id]);
  expect(await workspaceIds(other)).toEqual([]);
  expect(await workspaceIds(carolHome)).toEqual([]);
  expect(await workspaceIds(personal)).toEqual([]);

  // The id of his own personal space moves it there as null does, and is not recorded.
  await workspace.moveToSpace(bobPersonal.id);
  expect(await ownRecord(bob, id)).not.toHaveProperty("spaceId");
  expect(await workspaceIds(team)).toEqual([]);
  expect(await workspaceIds(personal)).toEqual([id]);
  await workspace.moveToSpace(spaceId);
  expect((await ownRecord(bob, id)).spaceId).toBe(spaceId);
  expect(await workspaceIds(team)).toEqual([id]);
  expect(await workspaceIds(personal)).toEqual([]);

  // Out to his personal space by null, and back.
  await workspace.moveToSpace(null);
  expect(await ownRecord(bob, id)).not.toHaveProperty("spaceId");
  expect(await workspaceIds(team)).toEqual([]);
  expect(await workspaceIds(personal)).toEqual([id]);
  await workspace.moveToSpace(spaceId);
  expect((await ownRecord(bob, id)).spaceId).toBe(spaceId);
  expect(await workspaceIds(team)).toEqual([id]);
  expect(await workspaceIds(personal)).toEqual([]);

  // The deleted workspace takes itself off the space's listing, as another member reads it, and
  // off its owner's own list.
  await workspace.deleteSelf();
  await unlisted(aliceSpace, id);
  await waitFor(`workspace ${id} to leave its owner's list`, async () =>
    (await bob.listWorkspaces()).every(gadget => gadget.id !== id) || null);
});

it.concurrent(
    "places a new workspace by a space id, also from a blueprint, and refuses a string that is none",
    async () => {
  const [aliceName, bobName] = usernames("alice", "bob");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  const bob = await newAccount(stack, bobName);
  using space = await alice.createSpace("Crew");
  const { id: spaceId } = await space.getInfo();
  const personalInfo = await personalSpaceOf(alice);
  using personal = await alice.openSpace(personalInfo.id);
  const { blueprintId } = await waitFor("the bundled document format to install", async () =>
    (await alice.listOutputFormats()).find(format => format.output.id === "document") ?? null);
  const ownIds = async () => (await alice.listWorkspaces()).map(({ id }) => id).toSorted();
  // A workspace Alice makes from the blueprint, naming the space `target` if one is given.
  const fromBlueprint = async (target?: string) => {
    const workspace = stack.use(await alice.newWorkspaceFromBlueprint(blueprintId, {}, target));
    return workspace.getMetadata();
  };

  // A string that is no space id is refused in the words opening a space by it is, by the server
  // and by Alice's account behind it alike.
  using scratch = await alice.newWorkspace();
  const { id: scratchId } = await scratch.getMetadata();
  const before = await ownIds();
  const invalid = await refusal(alice.openSpace("not-an-id"));
  expect(invalid).toMatch(INVALID_ID);
  for (const bad of notIds(scratchId)) {
    expect(await refusal(alice.newWorkspace(bad)), bad).toBe(invalid);
    expect(await refusal(alice.newWorkspaceFromBlueprint(blueprintId, {}, bad)), bad)
        .toBe(invalid);
  }
  // A refused blueprint call made no workspace: one would have seen activity, and so would be
  // in her list. A workspace made with no blueprint has seen none and is in no list either way,
  // so this says nothing of the other refused call.
  expect(await ownIds()).toEqual(before);

  // Instantiating a blueprint is the workspace's first activity, so it registers as it is made.
  // The id of her own personal space places a workspace there, as no id does, and is not recorded.
  const home = await fromBlueprint(personalInfo.id);
  await listedAs(personal, home.id, home.title);
  expect(await ownRecord(alice, home.id)).not.toHaveProperty("spaceId");

  // A team space she is not in and another user's personal space do not refuse the call: each
  // workspace is made, blank or from the blueprint, and ends up in her personal space once it has
  // seen activity and the space it named has turned it away.
  using bobSpace = await bob.createSpace("Elsewhere");
  const bobPersonalInfo = await personalSpaceOf(bob);
  using bobPersonal = await bob.openSpace(bobPersonalInfo.id);
  for (const target of [(await bobSpace.getInfo()).id, bobPersonalInfo.id]) {
    const blank = stack.use(await alice.newWorkspace(target));
    await blank.newChat("Seen activity, with no agent", null);
    for (const turnedAway of [await blank.getMetadata(), await fromBlueprint(target)]) {
      await waitFor(`workspace ${turnedAway.id} to fall back to its owner's personal space`,
          async () => {
        const record = (await alice.listWorkspaces()).find(gadget => gadget.id === turnedAway.id);
        return record !== undefined && !("spaceId" in record) ? record : null;
      });
      await listedAs(personal, turnedAway.id, turnedAway.title);
      expect(await ownRecord(alice, turnedAway.id)).not.toHaveProperty("spaceId");
    }
    expect(await workspaceIds(bobSpace)).toEqual([]);
    expect(await workspaceIds(bobPersonal)).toEqual([]);
  }

  // A team space she may add to lists the workspace, and her record of it names the space.
  const placed = await fromBlueprint(spaceId);
  await listedAs(space, placed.id, placed.title);
  expect((await ownRecord(alice, placed.id)).spaceId).toBe(spaceId);
  expect(await workspaceIds(space)).toEqual([placed.id]);
});
