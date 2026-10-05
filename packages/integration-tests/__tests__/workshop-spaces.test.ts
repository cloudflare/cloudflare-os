// Spaces end to end over the real RPC API: a user's personal space, team spaces and their keys,
// the member list as the one authority on who may open a space and change it, and the workspaces
// a space lists.
//
// A user's listing of their spaces is a record their own account keeps, which each space writes
// before the call that changed a membership returns. So these tests read it back directly, with
// no polling.
//
// A space's listing of workspaces is read back directly too after a move or a deletion, which
// are finished when their call returns. A workspace's first activity, a change of its title and
// its coming to hold restricted data or to be owner-invites-only reach the listing through a sync
// its owner's account runs apart from the call that caused it, so there, and only there, the
// tests poll with a bounded wait (`listedAs`, `unlisted`).
//
// The fixture gatekeeper is bound for the one thing it is the cheapest real way to do: record an
// observation marked as restricted data, or as owner-invites-only, through a session on one of
// its connections (`TestSession.readValue`).

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  isValidSpaceKey, PERSONAL_SPACE_PREFIX,
  type AuthenticatedApi, type Space, type SpaceInfo, type SpaceMemberInfo,
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

// Fresh team space keys, unique for the harness's lifetime the way usernames are. The dash is
// part of the key grammar.
const teamKeys = (...prefixes: string[]) => usernames(...prefixes).map(name => `team-${name}`);

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

/** `key` as the caller's listing shows it, if it does. */
const listed = async (api: RpcStub<AuthenticatedApi>, key: string) =>
  (await api.listSpaces()).find(space => space.key === key);

// Member lists are compared as (id, role) pairs in id order, whatever order the space lists in.
const sorted = (...members: { id: string; role: string }[]) =>
  members.toSorted((a, b) => a.id.localeCompare(b.id));
const roles = (members: SpaceMemberInfo[]) =>
  sorted(...members.map(({ profile, role }) => ({ id: profile.id, role })));

// The refusals the tests tell apart, matched loosely so they follow the meaning, not the wording.
const KEY_TAKEN = /already exists/i;
const NOT_ADMIN = /only an admin/i;
const KEEPS_AN_ADMIN = /at least one admin/i;
const NOT_A_MEMBER = /not a member/i;
const OWNER_IS_ONLY_ADMIN = /only admin/i;
const OWNER_ONLY = /only the workspace owner/i;

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
  const record = (await api.listGadgets()).find(gadget => gadget.id === id);
  if (record === undefined) throw new Error(`Workspace ${id} is not in its owner's list`);
  expect(record).not.toHaveProperty("registered");
  return record;
}

it.concurrent("lists the caller's personal space first, under one key from every session",
    async () => {
  const [aliceName] = usernames("alice");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName, "Alice Example");
  const second = stack.use(await logIn(stack.use(connect(requireHarness().url)), aliceName));

  // First use from two sessions at once: both land on the one space allocated for her.
  const [first, concurrent] = await Promise.all([alice.listSpaces(), second.listSpaces()]);
  expect(first).toHaveLength(1);
  const personal = first[0];
  expect(personal).toMatchObject({
    kind: "personal",
    role: "admin",
    owner: { type: "user", id: aliceName, name: "Alice Example" },
  });
  expect(personal.key.startsWith(PERSONAL_SPACE_PREFIX)).toBe(true);
  expect(isValidSpaceKey(personal.key)).toBe(true);
  expect(concurrent).toEqual(first);
  expect(await alice.listSpaces()).toEqual(first);

  // A session opened after the space exists finds it under the same key.
  const later = stack.use(await logIn(stack.use(connect(requireHarness().url)), aliceName));
  expect(await later.listSpaces()).toEqual(first);

  using space = await later.openSpace(personal.key);
  expect(await space.getInfo()).toEqual(personal);
  const members = await space.listMembers();
  expect(roles(members)).toEqual([{ id: aliceName, role: "admin" }]);
  expect(members[0].added).toBeInstanceOf(Date);
});

it.concurrent("creates team spaces their creator lists as their admin", async () => {
  const [aliceName] = usernames("alice");
  const [zuluKey, alphaKey] = teamKeys("first", "second");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);

  using zulu = await alice.createSpace(zuluKey, "  Zulu Crew  ");
  const zuluInfo = await zulu.getInfo();
  expect(zuluInfo).toEqual({ key: zuluKey, name: "Zulu Crew", kind: "team", role: "admin" });
  expect(zuluInfo.owner).toBeUndefined();
  expect(roles(await zulu.listMembers())).toEqual([{ id: aliceName, role: "admin" }]);

  using alpha = await alice.createSpace(alphaKey, "Alpha Crew");
  const alphaInfo = await alpha.getInfo();
  expect(alphaInfo).toEqual({ key: alphaKey, name: "Alpha Crew", kind: "team", role: "admin" });

  // The personal space leads, then the others by name: Zulu Crew is older and its key sorts first.
  const spaces = await alice.listSpaces();
  expect(spaces[0]).toMatchObject({ kind: "personal", owner: { id: aliceName } });
  expect(spaces.slice(1)).toEqual([alphaInfo, zuluInfo]);
});

it.concurrent("refuses a taken key, a malformed key and a blank name", async () => {
  const [aliceName, bobName] = usernames("alice", "bob");
  const [key, spareKey] = teamKeys("taken", "spare");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  const bob = await newAccount(stack, bobName);
  const before = await alice.listSpaces();

  using space = await alice.createSpace(key, "Taken");
  const taken = await refusal(alice.createSpace(key, "Again"));
  expect(taken).toMatch(KEY_TAKEN);
  expect(await refusal(bob.createSpace(key, "Mine now"))).toBe(taken);
  // Neither refused claim took the space over or joined it.
  expect(await space.getInfo()).toEqual({ key, name: "Taken", kind: "team", role: "admin" });
  expect(roles(await space.listMembers())).toEqual([{ id: aliceName, role: "admin" }]);
  const notAMember = await refusal(bob.openSpace(key));
  expect(notAMember).not.toMatch(KEY_TAKEN);

  // Upper case, too short, a personal key (too short and well-formed), a leading dash, over-long,
  // empty and a character outside the alphabet.
  const malformedKeys = [
    "Upper-Case", "a", `${PERSONAL_SPACE_PREFIX}x`, `${PERSONAL_SPACE_PREFIX}${bobName}`, "-lead",
    "x".repeat(33), "", "two words",
  ];
  const malformed = await refusal(alice.createSpace(malformedKeys[0], "Malformed"));
  expect(malformed).not.toBe(taken);
  for (const badKey of malformedKeys) {
    expect(await refusal(alice.createSpace(badKey, "Malformed")), badKey).toBe(malformed);
  }
  // Opening refuses the ones that cannot name a space of either kind as malformed, which is not
  // the refusal a well-formed key gets when the caller has no space under it.
  for (const badKey of malformedKeys.filter(candidate => !isValidSpaceKey(candidate))) {
    expect(await refusal(alice.openSpace(badKey)), badKey).not.toBe(notAMember);
  }

  // A name is trimmed before it is judged, and a refused name claims nothing: the key is still
  // free for someone else.
  expect(await refusal(alice.createSpace(spareKey, "   "))).not.toMatch(KEY_TAKEN);
  expect(await refusal(alice.createSpace(spareKey, "n".repeat(10_000)))).not.toMatch(KEY_TAKEN);
  using spare = await bob.createSpace(spareKey, "Spare");
  expect(await spare.getInfo()).toMatchObject({ key: spareKey, name: "Spare", role: "admin" });

  // All that the attempts left in the creator's listing is the one space she created.
  expect(await alice.listSpaces()).toEqual([...before, await space.getInfo()]);
});

it.concurrent("refuses a non-member and an unclaimed key alike", async () => {
  const [aliceName, bobName] = usernames("alice", "bob");
  const [key, unclaimedKey] = teamKeys("closed", "unclaimed");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  const bob = await newAccount(stack, bobName);
  using space = await alice.createSpace(key, "Closed");
  const alicePersonal = await personalSpaceOf(alice);
  const bobPersonal = await personalSpaceOf(bob);
  expect(bobPersonal.key).not.toBe(alicePersonal.key);

  const notAMember = await refusal(bob.openSpace(key));
  expect(await refusal(bob.openSpace(unclaimedKey))).toBe(notAMember);
  expect(await refusal(bob.openSpace(alicePersonal.key))).toBe(notAMember);
  expect(await refusal(bob.openSpace(PERSONAL_SPACE_PREFIX + unclaimedKey))).toBe(notAMember);

  // Asking joined nothing and claimed nothing.
  expect(await bob.listSpaces()).toEqual([bobPersonal]);
  expect(roles(await space.listMembers())).toEqual([{ id: aliceName, role: "admin" }]);
  using claimed = await bob.createSpace(unclaimedKey, "Claimed after all");
  expect(await claimed.getInfo()).toMatchObject({ key: unclaimedKey, role: "admin" });
});

it.concurrent("a member's role and removal reach their listing and their open stub", async () => {
  const [aliceName, bobName, ghostName] = usernames("alice", "bob", "ghost");
  const [key] = teamKeys("crew");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  const bob = await newAccount(stack, bobName);
  using space = await alice.createSpace(key, "Crew");
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
  expect(bobSpaces[1]).toEqual({ key, name: "Crew", kind: "team", role: "build" });
  using bobSpace = await bob.openSpace(key);
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
  expect(await listed(bob, key)).toMatchObject({ role: "use" });

  // Removal reaches the stub Bob already holds, and leaves him where a stranger stands.
  await space.removeMember(bobName);
  const removed = await refusal(bobSpace.getInfo());
  expect(await bob.listSpaces()).toEqual([bobSpaces[0]]);
  expect(await refusal(bob.openSpace(key))).toBe(removed);
  expect(roles(await space.listMembers())).toEqual([{ id: aliceName, role: "admin" }]);
});

it.concurrent("a personal space takes members but keeps its owner as its only admin", async () => {
  const [aliceName, bobName] = usernames("alice", "bob");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  const bob = await newAccount(stack, bobName);
  const personal = await personalSpaceOf(alice);
  using space = await alice.openSpace(personal.key);

  expect(await refusal(space.setMemberRole(bobName, "admin"))).toMatch(OWNER_IS_ONLY_ADMIN);
  expect(await space.setMemberRole(bobName, "build")).toMatchObject({ role: "build" });
  // The owner is neither demoted nor removed, not even by herself.
  expect(await refusal(space.setMemberRole(aliceName, "build"))).toMatch(KEEPS_AN_ADMIN);
  expect(await refusal(space.removeMember(aliceName))).toMatch(KEEPS_AN_ADMIN);
  expect(roles(await space.listMembers())).toEqual(sorted(
      { id: aliceName, role: "admin" }, { id: bobName, role: "build" }));

  // Bob lists his own personal space ahead of the one he was added to.
  const bobSpaces = await bob.listSpaces();
  expect(bobSpaces).toHaveLength(2);
  expect(bobSpaces[0]).toMatchObject({ kind: "personal", owner: { id: bobName }, role: "admin" });
  expect(bobSpaces[1]).toEqual({ ...personal, role: "build" });
});

it.concurrent("a team space lists a member's workspace once it has seen activity, under its title",
    async () => {
  const [aliceName, bobName] = usernames("alice", "bob");
  const [key] = teamKeys("crew");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  const bob = await newAccount(stack, bobName, "Bob Example");
  using space = await alice.createSpace(key, "Crew");
  await space.setMemberRole(bobName, "use");

  // Bob creates two workspaces in the space, and only the second goes on to see activity.
  using draft = await bob.newGadget(key);
  await draft.setTitle("Draft");
  using workspace = await bob.newGadget(key);
  const { id } = await workspace.getMetadata();
  await workspace.setTitle("Roadmap");
  expect(await space.listWorkspaces()).toEqual([]);

  // A chat that starts no agent is the cheapest thing that counts as activity.
  await workspace.newChat("Seen activity, with no agent", null);
  const entry = await listedAs(space, id, "Roadmap");
  const record = await ownRecord(bob, id);
  expect(record.spaceKey).toBe(key);
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

it.concurrent("a workspace that holds restricted data or is owner-invites-only leaves the listing",
    async () => {
  const [aliceName, bobName] = usernames("alice", "bob");
  const [key] = teamKeys("crew");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  const bob = await newAccount(stack, bobName);
  using space = await alice.createSpace(key, "Crew");
  await space.setMemberRole(bobName, "use");
  // The listing is read as Bob throughout: the member who owns neither workspace.
  using listing = await bob.openSpace(key);
  await alice.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = await waitFor("the fixture account to be provisioned", async () =>
    (await listConnectedAccounts(alice)).find(({ vendorId }) => vendorId === TEST_VENDOR_ID) ?? null);

  // A workspace of Alice's that the space lists, and a session to observe through on a fixture
  // connection of its own.
  const listedWorkspace = async (title: string) => {
    const workspace = stack.use(await alice.newGadget(key));
    const { id } = await workspace.getMetadata();
    await workspace.setTitle(title);
    await workspace.newChat("Seen activity, with no agent", null);
    await listedAs(listing, id, title);
    using connection = await workspace.newGatekeeper(
        account.id, `https://gadgets-test.example/things/${id}`);
    if (connection === null) throw new Error("Failed to create the test connection");
    const session = stack.use(await connection.openSession() as RpcStub<TestSession>);
    return { id, workspace, session };
  };
  const restricted = await listedWorkspace("Plan");
  const invitesOnly = await listedWorkspace("Budget");

  // An observation marked as restricted data takes its workspace off the listing.
  expect(await restricted.session.readValue(true)).toBe(42);
  await unlisted(listing, restricted.id);

  // No later title brings it back. Alice's account syncs her workspaces one at a time, so once
  // the listing shows the other workspace's change of title, made after this one's, it is past
  // this one's.
  await restricted.workspace.setTitle("Plan, from the data");
  await invitesOnly.workspace.setTitle("Budget, revised");
  await listedAs(listing, invitesOnly.id, "Budget, revised");
  expect(await workspaceIds(listing)).toEqual([invitesOnly.id]);

  // An observation marked as owner-invites-only, and as nothing else, does the same.
  expect(await invitesOnly.session.readValue(false, true)).toBe(42);
  await unlisted(listing, invitesOnly.id);
  // Nor does a later title bring this one back. A move is finished when its call returns, and
  // Alice's account takes it up after the sync that title started, so by then that sync has run.
  await invitesOnly.workspace.setTitle("Budget, from the data");
  await restricted.workspace.moveToSpace(key);
  expect(await listing.listWorkspaces()).toEqual([]);

  // Alice's own records still say where she grouped the two, now with the flags each workspace
  // reported, and she opens both as before.
  expect(await ownRecord(alice, restricted.id)).toMatchObject({
    title: "Plan, from the data", spaceKey: key,
    containsRestrictedData: true, ownerInvitesOnly: false,
  });
  expect(await ownRecord(alice, invitesOnly.id)).toMatchObject({
    title: "Budget, from the data", spaceKey: key,
    containsRestrictedData: false, ownerInvitesOnly: true,
  });
  for (const { id } of [restricted, invitesOnly]) {
    using reopened = await alice.openGadget(id);
    expect(await reopened.getMetadata()).toMatchObject({ id });
  }
});

it.concurrent("only its owner moves a workspace, and only where they may add; deleting unlists it",
    async () => {
  const [aliceName, bobName, carolName] = usernames("alice", "bob", "carol");
  const [key, otherKey, unclaimedKey] = teamKeys("crew", "other", "unclaimed");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  const bob = await newAccount(stack, bobName);
  const carol = await newAccount(stack, carolName);
  using aliceSpace = await alice.createSpace(key, "Crew");
  await aliceSpace.setMemberRole(bobName, "use");
  using other = await carol.createSpace(otherKey, "Other");
  // Bob's two spaces are read as Bob: his is the session his deleting the workspace leaves alone.
  using team = await bob.openSpace(key);
  using personal = await bob.openSpace((await personalSpaceOf(bob)).key);

  using workspace = await bob.newGadget(key);
  const { id } = await workspace.getMetadata();
  await workspace.setTitle("Tracker");
  await workspace.newChat("Seen activity, with no agent", null);
  await listedAs(team, id, "Tracker");

  // Alice administers the space and builds on the workspace; Carol, outside the space, builds on
  // it too and names a space of her own. Neither is the owner.
  await workspace.addCollaborator(aliceName, "build");
  await workspace.addCollaborator(carolName, "build");
  {
    using asAlice = await alice.openGadget(id);
    using asCarol = await carol.openGadget(id);
    expect(await refusal(asAlice.moveToSpace(null))).toMatch(OWNER_ONLY);
    expect(await refusal(asCarol.moveToSpace(otherKey))).toMatch(OWNER_ONLY);
  }

  // The owner is refused a space he is not in, and a key nobody claimed, alike, and nothing moves.
  const notAMember = await refusal(workspace.moveToSpace(otherKey));
  expect(notAMember).toMatch(NOT_A_MEMBER);
  expect(await refusal(workspace.moveToSpace(unclaimedKey))).toBe(notAMember);
  expect((await ownRecord(bob, id)).spaceKey).toBe(key);
  expect(await workspaceIds(team)).toEqual([id]);
  expect(await workspaceIds(other)).toEqual([]);
  expect(await workspaceIds(personal)).toEqual([]);

  // Out to his personal space, and back.
  await workspace.moveToSpace(null);
  expect(await ownRecord(bob, id)).not.toHaveProperty("spaceKey");
  expect(await workspaceIds(team)).toEqual([]);
  expect(await workspaceIds(personal)).toEqual([id]);
  await workspace.moveToSpace(key);
  expect((await ownRecord(bob, id)).spaceKey).toBe(key);
  expect(await workspaceIds(team)).toEqual([id]);
  expect(await workspaceIds(personal)).toEqual([]);

  await workspace.deleteSelf();
  expect(await workspaceIds(team)).toEqual([]);
});

it.concurrent("creates a workspace under a team key only, also from a blueprint", async () => {
  const [aliceName] = usernames("alice");
  const [key] = teamKeys("crew");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  using space = await alice.createSpace(key, "Crew");
  const { blueprintId } = await waitFor("the bundled document format to install", async () =>
    (await alice.listOutputFormats()).find(format => format.output.id === "document") ?? null);

  // Only a team key places a workspace: not a personal key, the caller's own included, and
  // nothing malformed. The refusal is the one creating a space under such a key gets.
  const personal = await personalSpaceOf(alice);
  const malformed = await refusal(alice.createSpace(personal.key, "Malformed"));
  for (const badKey of [personal.key, `${PERSONAL_SPACE_PREFIX}x`, "Bad Key", ""]) {
    expect(await refusal(alice.newGadget(badKey)), badKey).toBe(malformed);
    expect(await refusal(alice.newGadgetFromBlueprint(blueprintId, {}, badKey)), badKey)
        .toBe(malformed);
  }

  // Instantiating a blueprint is the workspace's first activity, so it registers as it is made.
  using workspace = await alice.newGadgetFromBlueprint(blueprintId, {}, key);
  const { id, title } = await workspace.getMetadata();
  await listedAs(space, id, title);
  expect((await ownRecord(alice, id)).spaceKey).toBe(key);
});
