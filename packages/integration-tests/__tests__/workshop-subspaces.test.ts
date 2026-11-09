// Sub-spaces end to end over the real RPC API: a space created inside another, which the members
// of the space above reach in at least the role they hold there, and which takes members of its
// own, who reach it and what is below it and nothing above or beside it. The tests cover who may
// create a sub-space, change its members and add workspaces to it, what a role held in a space
// above gives on a workspace a sub-space lists, and how lowering or ending that role reaches the
// sessions already open through it and the `Space` stubs already held.
//
// A sub-space asks each of the spaces it is inside directly, side by side, which role that space
// itself gave a user, and none of them asks another. So the test that nests as deep as the
// Workshop allows is where one request reaches the most spaces: the Workshop, the workspace, its
// owner's account, the deepest sub-space, and from it every space above.
//
// A user's listing of their spaces and a space's listing of its sub-spaces are written before
// the call that changed them returns, and so is a space's listing of workspaces after a move.
// They are read back directly. Three things are waited for with a bounded poll: what reaches a
// space's listing through a sync the workspace's owner's account runs apart from the call that
// caused it, which is a workspace's first activity and a change of its title
// (`activate`, `listedAs`); a session ended by its workspace's restart, which
// is how a workspace ends the sessions opened through a role that its space took back
// (`severed`); and an open that such a restart may cut short, which is tried again (`refused`,
// `reopens`). A restart ends every session that holds the workspace. So its owner holds it on a
// session apart from the one she changes the spaces on, and everyone else whose session a test
// goes on to end opens it on a session they use for nothing else.
//
// The fixture gatekeeper is bound for the one thing it is the cheapest real way to do: record an
// observation marked as restricted data, or as owner-invites-only, through a session on one of
// its connections (`TestSession.readValue`).

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  getOpenWorkspaceErrorCode, OPEN_WORKSPACE_ERROR_CODES, type AuthenticatedApi, type Overseer,
  type Space, type SpaceInfo, type SpaceMemberRole,
} from "@gadgets/workshop-shared/api";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  type Harness, settleRestart, startTestGatekeeperHarness, TEST_VENDOR_ID,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, logIn, MAX_OBSERVER_PROMPTS, nextUsernames,
  ObserverConfigRecorder, signUp, stubFor, waitFor,
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

// The refusals the tests tell apart.
const NO_SUCH_SPACE = "No such space, or you are not a member of it.";
const ADMINS_ONLY = "Only an admin of this space can change its members.";
const NO_MEMBERS = "A personal space has no members.";
const BUILDERS_ONLY = "Only an admin or a build member of this space can create a sub-space.";
const BAD_NAME = "A space name is 1 to 100 characters.";
const USE_ONLY = "Unauthorized: this collaborator only has permission to use the gadget's UI.";
const NO_SHARING = "You do not have permission to share this workspace.";
// How many levels of sub-spaces the Workshop allows below a root (MAX_SPACE_DEPTH in its
// spaces module, which this package cannot import).
const MAX_SPACE_DEPTH = 5;
const TOO_DEEP = `A space can be nested at most ${MAX_SPACE_DEPTH} levels deep.`;

/** Signs the account `username` up on a session of its own; `stack` owns both. */
async function account(stack: DisposableStack, username: string)
    : Promise<RpcStub<AuthenticatedApi>> {
  return stack.use(await signUp(stack.use(connect(requireHarness().url)), username));
}

/** A session for the existing account `username`; `stack` owns it. */
async function session(stack: DisposableStack, username: string)
    : Promise<RpcStub<AuthenticatedApi>> {
  return stack.use(await logIn(stack.use(connect(requireHarness().url)), username));
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

/**
 * Gives the account `username` the role `role` in `space` itself, and returns their profile id,
 * which is what `Space.removeMember` names a member by.
 */
async function addMember(space: RpcStub<Space>, username: string, role: SpaceMemberRole) {
  const member = await space.setMemberRole(username, role);
  if (member === null) throw new Error(`No account for ${username}`);
  return member.profile.id;
}

/**
 * Creates the sub-space `name` in `parent` and opens it as `api`'s user, by the id its creation
 * returned: creating a sub-space returns no stub. `stack` owns the opened space.
 */
async function subspace(
    stack: DisposableStack, api: RpcStub<AuthenticatedApi>, parent: RpcStub<Space>, name: string) {
  const { id } = await parent.createSubspace(name);
  return { id, space: stack.use(await api.openSpace(id)) };
}

/** The caller's personal space: the first entry of their listing. */
async function personalSpaceOf(api: RpcStub<AuthenticatedApi>): Promise<SpaceInfo> {
  const [personal] = await api.listSpaces();
  if (personal === undefined) throw new Error("The listing held no personal space");
  expect(personal.kind).toBe("personal");
  return personal;
}

/** The ids of the spaces the caller's listing holds. */
const spaceIds = async (api: RpcStub<AuthenticatedApi>) =>
  (await api.listSpaces()).map(({ id }) => id);

/** A workspace of `ownerName`'s in the space `spaceId`, held on a session of its own. */
async function workspaceIn(stack: DisposableStack, ownerName: string, spaceId?: string) {
  const workspace = stack.use(await (await session(stack, ownerName)).newWorkspace(spaceId));
  return { workspace, id: (await workspace.getMetadata()).id };
}

/** Workspace `id` as `username` opens it on a session of its own, which `stack` owns. */
async function opened(stack: DisposableStack, username: string, id: string) {
  return stack.use(await (await session(stack, username)).openWorkspace(id));
}

/** Makes a gadget of `workspace`'s that belongs to no chat, and returns its id. */
async function newGadget(workspace: RpcStub<Overseer>, bindingName: string) {
  using gadget = workspace.createGadget("App", undefined, bindingName);
  return await gadget.getId();
}

/** The ids of the workspaces `space` lists, in its order. */
const workspaceIds = async (space: RpcStub<Space>) =>
  (await space.listWorkspaces()).map(({ id }) => id);

/** Gives `workspace` its first activity and polls, for a bounded time, until `space` lists it. */
async function activate(space: RpcStub<Space>, workspace: RpcStub<Overseer>, id: string) {
  // A chat that starts no agent is the cheapest thing that counts as activity.
  await workspace.newChat("Seen activity, with no agent", null);
  await waitFor(`workspace ${id} in the space's listing`, async () =>
    (await workspaceIds(space)).includes(id) || null);
}

/** Polls, for a bounded time, until `space` lists workspace `id` under `title`. */
const listedAs = (space: RpcStub<Space>, id: string, title: string) =>
  waitFor(`workspace "${title}" in the space's listing`, async () => {
    const entry = (await space.listWorkspaces()).find(workspace => workspace.id === id);
    return entry?.title === title ? entry : null;
  });

/** Polls, for a bounded time, until the session that holds `workspace` has been ended. */
const severed = (workspace: RpcStub<Overseer>) =>
  waitFor("the workspace's restart to end the session", () =>
    workspace.getMetadata().then(() => null, () => true));

/**
 * Whether `username`, on a new session, is refused workspace `id`: it exists, and gives them
 * nothing. An open that the workspace's restart cuts short answers neither way, so it is tried
 * again, for a bounded time.
 */
const refused = (username: string, id: string) =>
  waitFor(`${username} to open workspace ${id} or be refused it`, async () => {
    using stack = new DisposableStack();
    try {
      await opened(stack, username, id);
      return false;
    } catch (error) {
      return getOpenWorkspaceErrorCode(error) === OPEN_WORKSPACE_ERROR_CODES.workspaceAccessDenied
          || null;
    }
  });

/**
 * The role `username` opens workspace `id` in on a new session, once its restart is over: an
 * open the restart cuts short is tried again, for a bounded time. Fails if they are refused it.
 */
const reopens = (username: string, id: string) =>
  waitFor(`${username} to open workspace ${id} after its restart`, async () => {
    using stack = new DisposableStack();
    try {
      return (await (await opened(stack, username, id)).getMetadata()).role;
    } catch (error) {
      if (getOpenWorkspaceErrorCode(error) === undefined) return null;
      throw error;
    }
  });

/** The fixture account of `api`'s user, provisioned here. */
async function fixtureAccount(api: RpcStub<AuthenticatedApi>) {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the fixture account to be provisioned", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
}

/**
 * The caller's own record of workspace `id`, which is what says where its owner placed it: the
 * metadata a workspace reports does not.
 */
async function ownRecord(api: RpcStub<AuthenticatedApi>, id: string) {
  const record = (await api.listWorkspaces()).find(gadget => gadget.id === id);
  if (record === undefined) throw new Error(`Workspace ${id} is not in its owner's list`);
  return record;
}

it.concurrent("a sub-space is listed by the space it was created in and open to whoever holds a "
    + "role there, in at least that role", async () => {
  using stack = new DisposableStack();
  const [aliceName, bobName] = nextUsernames("alice", "bob");
  const alice = await account(stack, aliceName);
  const bob = await account(stack, bobName);
  const design = stack.use(await alice.createSpace("Design"));
  const { id: designId } = await design.getInfo();

  // A name is trimmed as a team space's is. Creating returns the sub-space's id and name, and
  // the space it was created in lists it from then on.
  const created = await design.createSubspace("  Platform ");
  expect(created).toEqual({ id: expect.any(String), name: "Platform" });
  const platformId = created.id;
  expect(platformId).not.toBe(designId);
  expect(await design.listSubspaces()).toEqual([{ id: platformId, name: "Platform" }]);

  // Alice was given no role in it: she is its admin as the admin of the space it is inside, so
  // it lists no member and her own listing does not hold it.
  using platform = await alice.openSpace(platformId);
  expect(await platform.getInfo()).toEqual({
    id: platformId, name: "Platform", kind: "team", parent: designId, role: "admin",
  });
  expect(await platform.listMembers()).toEqual([]);
  expect(await platform.listSubspaces()).toEqual([]);
  expect(await spaceIds(alice)).toContain(designId);
  expect(await spaceIds(alice)).not.toContain(platformId);

  // Bob, who only uses the space above, opens the sub-space in that role and is told what it is
  // inside. He was given no role in it either.
  await design.setMemberRole(bobName, "use");
  using asBob = await bob.openSpace(platformId);
  expect(await asBob.getInfo()).toEqual({
    id: platformId, name: "Platform", kind: "team", parent: designId, role: "use",
  });
  expect(await asBob.listMembers()).toEqual([]);
  using bobDesign = await bob.openSpace(designId);
  expect(await bobDesign.listSubspaces()).toEqual([{ id: platformId, name: "Platform" }]);
  expect(await spaceIds(bob)).toContain(designId);
  expect(await spaceIds(bob)).not.toContain(platformId);

  // A workspace placed in the sub-space is listed there, not by the space above, and Bob's role
  // above is his role on it.
  const { workspace, id } = await workspaceIn(stack, aliceName, platformId);
  await activate(platform, workspace, id);
  expect(await workspaceIds(asBob)).toEqual([id]);
  expect(await workspaceIds(design)).toEqual([]);
  using viewing = await bob.openWorkspace(id);
  expect(await viewing.getMetadata()).toMatchObject({ id, role: "use" });

  // Someone who only uses a space creates no sub-space in it, and a blank name creates none.
  expect(await refusal(asBob.createSubspace("X"))).toBe(BUILDERS_ONLY);
  expect(await refusal(platform.createSubspace("  "))).toBe(BAD_NAME);
  expect(await platform.listSubspaces()).toEqual([]);
});

it.concurrent("someone added only to a sub-space reaches it and what is below it, and nothing "
    + "above or beside it", async () => {
  using stack = new DisposableStack();
  const [aliceName, bobName, carolName, malloryName] =
      nextUsernames("alice", "bob", "carol", "mallory");
  const alice = await account(stack, aliceName);
  const bob = await account(stack, bobName);
  const carol = await account(stack, carolName);
  const mallory = await account(stack, malloryName);
  const design = stack.use(await alice.createSpace("Design"));
  const { id: designId } = await design.getInfo();
  const { id: platformId, space: platform } = await subspace(stack, alice, design, "Platform");
  const { id: researchId } = await subspace(stack, alice, design, "Research");
  const carolId = await addMember(platform, carolName, "build");

  // Carol's sub-space does not tell her what it is inside, and the space above it and the
  // sub-space beside it answer her as a space that does not exist.
  using carolPlatform = await carol.openSpace(platformId);
  const carolInfo = await carolPlatform.getInfo();
  expect(carolInfo).toEqual({ id: platformId, name: "Platform", kind: "team", role: "build" });
  expect(carolInfo).not.toHaveProperty("parent");
  expect(await refusal(carol.openSpace(designId))).toBe(NO_SUCH_SPACE);
  expect(await refusal(carol.openSpace(researchId))).toBe(NO_SUCH_SPACE);
  const carolSpaces = await carol.listSpaces();
  expect(carolSpaces.filter(({ id }) => [designId, platformId, researchId].includes(id)))
      .toEqual([carolInfo]);
  expect(carolSpaces.find(({ id }) => id === platformId)).not.toHaveProperty("parent");

  // She builds, so she creates a sub-space of her own sub-space, where she holds the role she
  // was given above it and Alice the one she holds at the top.
  const { id: toolsId, space: carolTools } = await subspace(stack, carol, carolPlatform, "Tools");
  expect(await carolTools.getInfo()).toEqual({
    id: toolsId, name: "Tools", kind: "team", parent: platformId, role: "build",
  });
  using tools = await alice.openSpace(toolsId);
  expect(await tools.getInfo()).toEqual({
    id: toolsId, name: "Tools", kind: "team", parent: platformId, role: "admin",
  });

  // Only an admin changes members: not Carol, but Alice, who was given no role in Platform.
  expect(await refusal(carolPlatform.setMemberRole(bobName, "use"))).toBe(ADMINS_ONLY);
  const bobId = await addMember(platform, bobName, "use");
  using bobPlatform = await bob.openSpace(platformId);
  const bobInfo = await bobPlatform.getInfo();
  expect(bobInfo).toEqual({ id: platformId, name: "Platform", kind: "team", role: "use" });
  expect(bobInfo).not.toHaveProperty("parent");
  using bobTools = await bob.openSpace(toolsId);
  expect(await bobTools.getInfo()).toMatchObject({ role: "use", parent: platformId });
  expect(await refusal(bob.openSpace(designId))).toBe(NO_SUCH_SPACE);
  expect(await refusal(bob.openSpace(researchId))).toBe(NO_SUCH_SPACE);

  // A workspace two levels down opens to each in the role they hold in the sub-space above it,
  // and to nobody else. Mallory holds a role nowhere, and opens none of the four spaces.
  const { workspace, id } = await workspaceIn(stack, aliceName, toolsId);
  await activate(tools, workspace, id);
  expect(await (await opened(stack, carolName, id)).getMetadata())
      .toMatchObject({ id, role: "build" });
  expect(await (await opened(stack, bobName, id)).getMetadata())
      .toMatchObject({ id, role: "use" });
  expect(await refused(malloryName, id)).toBe(true);
  for (const spaceId of [designId, platformId, researchId, toolsId]) {
    expect(await refusal(mallory.openSpace(spaceId)), spaceId).toBe(NO_SUCH_SPACE);
  }

  // A move goes by the same role. Carol's own workspace has seen activity, so the space it
  // names is asked whether she may add to it: the spaces she cannot open refuse it in the words
  // they refuse her in, and the sub-space below the one she was added to takes it.
  using carolHome = await carol.openSpace((await personalSpaceOf(carol)).id);
  using mine = await carol.newWorkspace();
  const { id: mineId } = await mine.getMetadata();
  await activate(carolHome, mine, mineId);
  expect(await refusal(mine.moveToSpace(designId))).toBe(NO_SUCH_SPACE);
  expect(await refusal(mine.moveToSpace(researchId))).toBe(NO_SUCH_SPACE);
  expect(await ownRecord(carol, mineId)).not.toHaveProperty("spaceId");
  expect(await workspaceIds(carolHome)).toEqual([mineId]);
  await mine.moveToSpace(toolsId);
  expect((await ownRecord(carol, mineId)).spaceId).toBe(toolsId);
  expect((await workspaceIds(carolTools)).toSorted()).toEqual([id, mineId].toSorted());
  expect(await workspaceIds(platform)).toEqual([]);
  expect(await workspaceIds(carolHome)).toEqual([]);

  // Alice, an admin of Platform only by the role she holds above it, removes Carol from it.
  // That ends what Carol held below it too: creating Tools gave her no role of its own there.
  // Carol and Bob opened the workspace in Tools on sessions that are not used again: her
  // removal restarts it.
  await platform.removeMember(carolId);
  expect(await refusal(carol.openSpace(platformId))).toBe(NO_SUCH_SPACE);
  expect(await refusal(carol.openSpace(toolsId))).toBe(NO_SUCH_SPACE);
  expect(await spaceIds(carol)).not.toContain(platformId);
  expect(await refused(carolName, id)).toBe(true);

  // Bob, who still uses Platform, opens it, and then leaves it himself. It is left with no
  // member of its own, and open to Alice as before.
  expect(await bobPlatform.getInfo()).toEqual(bobInfo);
  await bobPlatform.removeMember(bobId);
  expect(await refusal(bob.openSpace(platformId))).toBe(NO_SUCH_SPACE);
  expect(await refusal(bobPlatform.getInfo())).toBe(NO_SUCH_SPACE);
  expect(await platform.listMembers()).toEqual([]);
  expect(await platform.getInfo()).toMatchObject({ id: platformId, role: "admin" });
});

it.concurrent("lowering, then removing, a member of the space above ends the sessions they hold "
    + "on a sub-space's workspace", async () => {
  using stack = new DisposableStack();
  const [aliceName, bobName] = nextUsernames("alice", "bob");
  const alice = await account(stack, aliceName);
  const bob = await account(stack, bobName);
  const design = stack.use(await alice.createSpace("Design"));
  const { id: platformId, space: platform } = await subspace(stack, alice, design, "Platform");
  const bobId = await addMember(design, bobName, "build");
  const { workspace, id } = await workspaceIn(stack, aliceName, platformId);
  await activate(platform, workspace, id);

  // Bob builds on the workspace, and holds the sub-space open from here to the end.
  const building = await opened(stack, bobName, id);
  expect(await building.getMetadata()).toMatchObject({ role: "build" });
  using held = await bob.openSpace(platformId);
  expect((await held.getInfo()).role).toBe("build");

  // Lowered in the space above, he loses the session he builds on, and the next one he opens
  // only uses. The stub he holds on the sub-space gives him the lower role at once.
  await design.setMemberRole(bobName, "use");
  expect((await held.getInfo()).role).toBe("use");
  expect(await refusal(held.createSubspace("X"))).toBe(BUILDERS_ONLY);
  await severed(building);
  const viewing = await opened(stack, bobName, id);
  expect(await viewing.getMetadata()).toMatchObject({ role: "use" });
  expect(await refusal(viewing.listChats())).toBe(USE_ONLY);

  // Removed from the space above, he loses that one too and is refused from then on, and the
  // stub he holds answers him as a space that does not exist: a role is looked up on every call
  // of a stub, in the space above as in the space itself.
  await design.removeMember(bobId);
  expect(await refusal(held.getInfo())).toBe(NO_SUCH_SPACE);
  expect(await refusal(held.listWorkspaces())).toBe(NO_SUCH_SPACE);
  expect(await refusal(bob.openSpace(platformId))).toBe(NO_SUCH_SPACE);
  await severed(viewing);
  expect(await refused(bobName, id)).toBe(true);
  expect(await platform.listSubspaces()).toEqual([]);
});

it.concurrent("someone given a role in a sub-space and another in the space above holds the "
    + "higher of the two, and the one that is left when the other ends", async () => {
  using stack = new DisposableStack();
  const [aliceName, bobName, carolName] = nextUsernames("alice", "bob", "carol");
  const alice = await account(stack, aliceName);
  const bob = await account(stack, bobName);
  const carol = await account(stack, carolName);
  const design = stack.use(await alice.createSpace("Design"));
  const { id: designId } = await design.getInfo();
  const { id: platformId, space: platform } = await subspace(stack, alice, design, "Platform");
  const platformInfo = { id: platformId, name: "Platform", kind: "team" };

  // Bob builds in the space above and only uses the sub-space; Carol the other way round. In
  // the sub-space each holds the higher of their two roles, whichever space gave it, and their
  // own listing holds the one the sub-space itself gave them.
  const bobId = await addMember(design, bobName, "build");
  await platform.setMemberRole(bobName, "use");
  await design.setMemberRole(carolName, "use");
  const carolId = await addMember(platform, carolName, "build");
  using bobPlatform = await bob.openSpace(platformId);
  using carolPlatform = await carol.openSpace(platformId);
  for (const space of [bobPlatform, carolPlatform]) {
    expect(await space.getInfo()).toEqual({ ...platformInfo, parent: designId, role: "build" });
  }
  expect((await bob.listSpaces()).find(({ id }) => id === platformId))
      .toEqual({ ...platformInfo, role: "use" });
  expect((await carol.listSpaces()).find(({ id }) => id === platformId))
      .toEqual({ ...platformInfo, role: "build" });

  // Both build on a workspace the sub-space lists, each on a session used for nothing else.
  const { workspace, id } = await workspaceIn(stack, aliceName, platformId);
  await activate(platform, workspace, id);
  const bobBuilding = await opened(stack, bobName, id);
  expect(await bobBuilding.getMetadata()).toMatchObject({ id, role: "build" });
  const carolBuilding = await opened(stack, carolName, id);
  expect(await carolBuilding.getMetadata()).toMatchObject({ id, role: "build" });

  // Removed from the space above, Bob is left with the role the sub-space gave him. The stub he
  // holds on it says so at once, and no longer what it is inside; the session he built on ends,
  // and the next one he opens only uses. The restart ended Carol's session too: her role stands.
  await design.removeMember(bobId);
  expect(await bobPlatform.getInfo()).toEqual({ ...platformInfo, role: "use" });
  expect(await refusal(bobPlatform.createSubspace("X"))).toBe(BUILDERS_ONLY);
  expect(await refusal(bob.openSpace(designId))).toBe(NO_SUCH_SPACE);
  await severed(bobBuilding);
  expect(await reopens(bobName, id)).toBe("use");
  expect(await reopens(carolName, id)).toBe("build");

  // Removed from the sub-space, Carol is left with the role she holds above it, in the same way.
  const carolAgain = await opened(stack, carolName, id);
  await platform.removeMember(carolId);
  expect(await carolPlatform.getInfo()).toEqual({ ...platformInfo, parent: designId, role: "use" });
  expect(await spaceIds(carol)).not.toContain(platformId);
  await severed(carolAgain);
  expect(await reopens(carolName, id)).toBe("use");
  expect(await platform.listMembers()).toMatchObject([{ profile: { id: bobId }, role: "use" }]);
});

it.concurrent("sub-spaces nest as deep as the Workshop allows, where members of the root still "
    + "open and use a workspace, and lose it with their role", async () => {
  using stack = new DisposableStack();
  const [aliceName, bobName, danaName] = nextUsernames("alice", "bob", "dana");
  const alice = await account(stack, aliceName);
  const bob = await account(stack, bobName);
  await account(stack, danaName);

  // A root and as many sub-spaces as fit below it, each created in the last. The deepest takes
  // no sub-space.
  const root = stack.use(await alice.createSpace("Root"));
  const levels = [{ id: (await root.getInfo()).id, space: root }];
  while (levels.length <= MAX_SPACE_DEPTH) {
    levels.push(await subspace(stack, alice, levels.at(-1)!.space, `Level ${levels.length}`));
  }
  const above = levels.slice(0, -1);
  const deepest = levels.at(-1)!;
  expect(await refusal(deepest.space.createSubspace("Deeper"))).toBe(TOO_DEEP);
  expect(await deepest.space.listSubspaces()).toEqual([]);

  // Bob and Dana are given a role in the root and nowhere else, and hold it at every level.
  const bobId = await addMember(root, bobName, "use");
  await root.setMemberRole(danaName, "build");
  for (const [depth, { id }] of levels.entries()) {
    using space = await bob.openSpace(id);
    const info = await space.getInfo();
    expect(info, `level ${depth}`).toMatchObject({ id, kind: "team", role: "use" });
    expect(info.parent, `level ${depth}`).toBe(depth === 0 ? undefined : levels[depth - 1].id);
  }

  // A workspace of Alice's at the deepest level, which no space above lists.
  const { workspace, id } = await workspaceIn(stack, aliceName, deepest.id);
  await activate(deepest.space, workspace, id);
  for (const { space } of above) expect(await workspaceIds(space)).toEqual([]);
  const gadgetId = await newGadget(workspace, "APP");

  // A role given in the root gives there what it gives on a workspace of the root itself: Bob
  // uses every gadget, Dana builds, and neither may share.
  const asBob = await opened(stack, bobName, id);
  expect(await asBob.getMetadata()).toMatchObject({ id, role: "use" });
  using app = await asBob.getGadget(gadgetId);
  expect(await app.getId()).toBe(gadgetId);
  expect(await refusal(asBob.listChats())).toBe(USE_ONLY);
  const asDana = await opened(stack, danaName, id);
  expect(await asDana.getMetadata()).toMatchObject({ id, role: "build" });
  expect(await asDana.listChats()).toHaveLength(1);
  expect(await refusal(asDana.addCollaborator(bobName, "workspace"))).toBe(NO_SHARING);
  expect(await workspace.listCollaborators()).toEqual([]);

  // Alice was given a role in the root alone, so the deepest sub-space asks every space above
  // it whether she may add a workspace she moves there.
  using personal = await alice.openSpace((await personalSpaceOf(alice)).id);
  const second = await workspaceIn(stack, aliceName);
  await activate(personal, second.workspace, second.id);
  await second.workspace.moveToSpace(deepest.id);
  expect((await ownRecord(alice, second.id)).spaceId).toBe(deepest.id);
  expect((await workspaceIds(deepest.space)).toSorted()).toEqual([id, second.id].toSorted());
  expect(await workspaceIds(personal)).toEqual([]);

  // Removed from the root, Bob loses the session he holds at the deepest level and every level
  // with it. Dana's role stands: the restart ended her session too, and she opens another.
  await root.removeMember(bobId);
  await severed(asBob);
  expect(await refused(bobName, id)).toBe(true);
  for (const { id: spaceId } of levels) {
    expect(await refusal(bob.openSpace(spaceId)), spaceId).toBe(NO_SUCH_SPACE);
  }
  expect(await reopens(danaName, id)).toBe("build");
});

it.concurrent("a sub-space of a personal space takes members, and the personal space itself "
    + "still takes none", async () => {
  using stack = new DisposableStack();
  const [aliceName, carolName] = nextUsernames("alice", "carol");
  const alice = await account(stack, aliceName);
  const carol = await account(stack, carolName);
  const { id: personalId } = await personalSpaceOf(alice);
  using personal = await alice.openSpace(personalId);

  // A sub-space of a personal space is a team space, which its owner administers from above.
  const { id: sharedId, space: shared } = await subspace(stack, alice, personal, "Shared");
  expect(await shared.getInfo()).toEqual({
    id: sharedId, name: "Shared", kind: "team", parent: personalId, role: "admin",
  });
  expect(await personal.listSubspaces()).toEqual([{ id: sharedId, name: "Shared" }]);
  expect(await spaceIds(alice)).toEqual([personalId]);

  // It takes a member, who reaches it and the workspaces it lists, and is not told that it is
  // inside a personal space.
  await shared.setMemberRole(carolName, "build");
  using carolShared = await carol.openSpace(sharedId);
  const carolInfo = await carolShared.getInfo();
  expect(carolInfo).toEqual({ id: sharedId, name: "Shared", kind: "team", role: "build" });
  expect(carolInfo).not.toHaveProperty("parent");
  const { workspace, id } = await workspaceIn(stack, aliceName, sharedId);
  await activate(shared, workspace, id);
  using asCarol = await carol.openWorkspace(id);
  expect(await asCarol.getMetadata()).toMatchObject({ id, role: "build" });

  // The personal space itself takes nobody and answers Carol as a space that does not exist,
  // and a workspace Alice keeps in it is refused to her.
  expect(await refusal(personal.setMemberRole(carolName, "use"))).toBe(NO_MEMBERS);
  expect(await refusal(carol.openSpace(personalId))).toBe(NO_SUCH_SPACE);
  const kept = await workspaceIn(stack, aliceName);
  await activate(personal, kept.workspace, kept.id);
  expect(await ownRecord(alice, kept.id)).not.toHaveProperty("spaceId");
  expect(await workspaceIds(shared)).toEqual([id]);
  expect(await refused(carolName, kept.id)).toBe(true);
});

it.concurrent("a sub-space lists a workspace that comes to hold restricted data or becomes "
    + "owner-invites-only like any other, and a role held above still opens it", async () => {
  using stack = new DisposableStack();
  const [aliceName, bobName] = nextUsernames("alice", "bob");
  const alice = await account(stack, aliceName);
  const bob = await account(stack, bobName);
  const design = stack.use(await alice.createSpace("Design"));
  const { id: platformId } = await subspace(stack, alice, design, "Platform");
  await design.setMemberRole(bobName, "build");
  // The listing is read as Bob throughout, who was given a role in the space above alone.
  using listing = await bob.openSpace(platformId);
  const fixture = await fixtureAccount(alice);
  const bobFixture = await fixtureAccount(bob);

  // What Bob is told of workspace `id` when he opens it in the role he holds above, on a
  // session he then closes. Whoever builds on a workspace is verified for what it is connected
  // to, so he opens it with an account of his own to answer with.
  const asBob = async (id: string) => {
    using visit = new DisposableStack();
    const choose = visit.use(stubFor(
        new ObserverConfigRecorder().alwaysChoose(bobFixture.id, MAX_OBSERVER_PROMPTS)));
    const workspace = visit.use(
        await (await session(visit, bobName)).openWorkspace(id, undefined, choose));
    return await workspace.getMetadata();
  };
  // A workspace of Alice's that the sub-space lists and Bob has opened, with a session to
  // observe through on a fixture connection of its own.
  const listedWorkspace = async (title: string) => {
    const { workspace, id } = await workspaceIn(stack, aliceName, platformId);
    await workspace.setTitle(title);
    await workspace.newChat("Seen activity, with no agent", null);
    await listedAs(listing, id, title);
    using connection = await workspace.newGatekeeper(
        fixture.id, `https://gadgets-test.example/things/${id}`);
    if (connection === null) throw new Error("Failed to create the test connection");
    const thing = stack.use(await connection.openSession() as RpcStub<TestSession>);
    expect(await asBob(id)).toMatchObject({ id, role: "build" });
    return { id, workspace, thing };
  };
  const plan = await listedWorkspace("Plan");
  const budget = await listedWorkspace("Budget");

  // An observation that sets `flag` restarts nothing, so the session Alice has held throughout
  // reads the flag. The sub-space lists the workspace as before, under a title given since, and
  // Bob builds on it in the role he holds above, verified as he was, and is told the flag.
  const staysOpen = async (
      { id, workspace }: { id: string; workspace: RpcStub<Overseer> },
      flag: "containsRestrictedData" | "ownerInvitesOnly", title: string) => {
    await settleRestart();
    expect(await workspace.getMetadata()).toMatchObject({ [flag]: true });
    await workspace.setTitle(title);
    await listedAs(listing, id, title);
    expect(await asBob(id)).toMatchObject({ id, role: "build", [flag]: true });
  };
  expect(await plan.thing.readValue(true)).toBe(42);
  await staysOpen(plan, "containsRestrictedData", "Plan, from the data");
  // An observation marked as owner-invites-only, and as nothing else.
  expect(await budget.thing.readValue(false, true)).toBe(42);
  await staysOpen(budget, "ownerInvitesOnly", "Budget, from the data");

  expect((await workspaceIds(listing)).toSorted()).toEqual([plan.id, budget.id].toSorted());
  for (const { id } of [plan, budget]) {
    expect(await ownRecord(alice, id)).toMatchObject({ spaceId: platformId });
  }
});
