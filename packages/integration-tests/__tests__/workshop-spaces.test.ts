// Spaces end to end over the real RPC API: a user's personal space, team spaces and their keys,
// and the member list as the one authority on who may open a space and change it.
//
// A user's listing of their spaces is a record their own account keeps, which each space writes
// before the call that changed a membership returns. So these tests read it back directly, with
// no polling.

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  isValidSpaceKey, PERSONAL_SPACE_PREFIX,
  type AuthenticatedApi, type SpaceInfo, type SpaceMemberInfo,
} from "@gadgets/workshop-shared/api";
import { type Harness, startHarness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, nextUsernames, signUp } from "../src/rpc-client.js";

let harness: Harness | undefined;
const network = new NetworkInterceptor();

beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [] });
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
const OWNER_IS_ONLY_ADMIN = /only admin/i;

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
  await expect(bobSpace.setMemberRole(bobName, "admin")).rejects.toThrow(NOT_ADMIN);
  await expect(bobSpace.removeMember(aliceName)).rejects.toThrow(NOT_ADMIN);
  await expect(space.setMemberRole(aliceName, "build")).rejects.toThrow(KEEPS_AN_ADMIN);
  await expect(space.removeMember(aliceName)).rejects.toThrow(KEEPS_AN_ADMIN);
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

  await expect(space.setMemberRole(bobName, "admin")).rejects.toThrow(OWNER_IS_ONLY_ADMIN);
  expect(await space.setMemberRole(bobName, "build")).toMatchObject({ role: "build" });
  // The owner is neither demoted nor removed, not even by herself.
  await expect(space.setMemberRole(aliceName, "build")).rejects.toThrow(KEEPS_AN_ADMIN);
  await expect(space.removeMember(aliceName)).rejects.toThrow(KEEPS_AN_ADMIN);
  expect(roles(await space.listMembers())).toEqual(sorted(
      { id: aliceName, role: "admin" }, { id: bobName, role: "build" }));

  // Bob lists his own personal space ahead of the one he was added to.
  const bobSpaces = await bob.listSpaces();
  expect(bobSpaces).toHaveLength(2);
  expect(bobSpaces[0]).toMatchObject({ kind: "personal", owner: { id: bobName }, role: "admin" });
  expect(bobSpaces[1]).toEqual({ ...personal, role: "build" });
});
