// A space member's role on the workspaces their space lists, end to end over the real RPC API:
// who opens a workspace through a membership and in which role, what that role does not give
// (any power to share), and how a membership that ends, is lowered or stops applying reaches the
// sessions already open through it.
//
// A space tells a workspace that a role it gave no longer holds from its alarm, and the workspace
// then restarts, which ends every session that holds it. So Alice, who owns the workspace and
// administers the space in every test, changes the space on one session and holds the workspace
// on another, and whoever lost a session opens the workspace again on a new one. Three things
// are waited for with a bounded poll: the restart ending a session (`severed`); an open that has
// to be refused, which the restart may cut short and so is tried again (`refused`); and a
// workspace's first listing, which follows its first activity (`activate`). An open that has to
// succeed is made once and not polled for: after a restart, on a new session, once `severed`
// has seen the old one end.
//
// The fixture gatekeeper is bound for one thing: recording an observation marked as restricted
// data or as owner-invites-only through a session on one of its connections
// (`TestSession.readValue`).

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  getOpenGadgetErrorCode, OPEN_GADGET_ERROR_CODES, type AuthenticatedApi, type Overseer,
  type Space, type SpaceMemberRole,
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

// The refusals the tests tell apart: of a call that takes "build", of sharing by someone the
// workspace's own sharing gives no role, and of granting more than it gives them.
const USE_ONLY = "Unauthorized: this collaborator only has permission to use the gadget's UI.";
const NO_SHARING = "You do not have permission to share this workspace.";
const ABOVE_OWN_ROLE = "You cannot grant a role higher than your own.";

/** A session for the existing account `username`; `stack` owns it. */
async function session(stack: DisposableStack, username: string)
    : Promise<RpcStub<AuthenticatedApi>> {
  return stack.use(await logIn(stack.use(connect(requireHarness().url)), username));
}

/**
 * Alice, Bob and Carol, each signed up on a session of their own, and a team space of Alice's
 * that the other two are not in yet.
 */
async function team(stack: DisposableStack) {
  const [aliceName, bobName, carolName] = nextUsernames("alice", "bob", "carol");
  const account = async (name: string) =>
    stack.use(await signUp(stack.use(connect(requireHarness().url)), name));
  const alice = await account(aliceName);
  const bob = await account(bobName);
  const carol = await account(carolName);
  // Unique for the harness's lifetime, as the usernames are. The dash is part of the key grammar.
  const key = `team-${aliceName}`;
  const space = stack.use(await alice.createSpace(key, "Crew"));
  return { aliceName, bobName, carolName, alice, bob, carol, key, space };
}

/**
 * Makes the account `username` a member of `space` in `role`, and returns their profile id,
 * which is what `Space.removeMember` names a member by.
 */
async function addMember(space: RpcStub<Space>, username: string, role: SpaceMemberRole) {
  const member = await space.setMemberRole(username, role);
  if (member === null) throw new Error(`No account for ${username}`);
  return member.profile.id;
}

/** A workspace of `ownerName`'s in team space `key`, held on a session of its own. */
async function workspaceIn(stack: DisposableStack, ownerName: string, key: string) {
  const workspace = stack.use(await (await session(stack, ownerName)).newGadget(key));
  return { workspace, id: (await workspace.getMetadata()).id };
}

/** Gives `workspace` its first activity and polls, for a bounded time, until `space` lists it. */
async function activate(space: RpcStub<Space>, workspace: RpcStub<Overseer>, id: string) {
  // A chat that starts no agent is the cheapest thing that counts as activity.
  await workspace.newChat("Seen activity, with no agent", null);
  await waitFor(`workspace ${id} in the space's listing`, async () =>
    (await space.listWorkspaces()).some(entry => entry.id === id) || null);
}

/** The message `call` is refused with. Fails if it succeeds. */
const refusal = (call: PromiseLike<unknown>) => Promise.resolve(call).then(
    () => { throw new Error("Expected the call to be refused"); },
    (error: unknown) => error instanceof Error ? error.message : String(error));

/** Polls, for a bounded time, until the session that holds `workspace` has been ended. */
const severed = (workspace: RpcStub<Overseer>) =>
  waitFor("the workspace's restart to end the session", () =>
    workspace.getMetadata().then(() => null, () => true));

/**
 * Whether `username`, on a new session, is refused workspace `id` with the access-denied code.
 * An open that the workspace's restart cuts short answers neither way, so it is tried again,
 * for a bounded time.
 */
const refused = (username: string, id: string) =>
  waitFor(`${username} to open workspace ${id} or be refused it`, async () => {
    using stack = new DisposableStack();
    try {
      stack.use(await (await session(stack, username)).openGadget(id));
      return false;
    } catch (error) {
      return getOpenGadgetErrorCode(error) === OPEN_GADGET_ERROR_CODES.workspaceAccessDenied
          || null;
    }
  });

it.concurrent("a member opens a listed workspace in the role of their membership, with no power "
    + "to share it, and nobody else opens it", async () => {
  using stack = new DisposableStack();
  const { aliceName, bobName, carolName, bob, carol, key, space } = await team(stack);
  await space.setMemberRole(bobName, "build");
  const { workspace, id } = await workspaceIn(stack, aliceName, key);

  // The space lists no workspace that has seen no activity, so it gives Bob no role on this one
  // yet. Carol is in no space of Alice's.
  expect(await refused(bobName, id)).toBe(true);
  await activate(space, workspace, id);
  expect(await refused(carolName, id)).toBe(true);

  // Bob, a "build" member nobody shared the workspace with, builds.
  using asBob = await bob.openGadget(id);
  expect(await asBob.getMetadata()).toMatchObject({ id, role: "build" });
  expect(await asBob.listChats()).toHaveLength(1);
  // What he may share is decided by the workspace's own sharing, which gives him nothing.
  expect(await refusal(asBob.addCollaborator(carolName, "use"))).toBe(NO_SHARING);
  expect(await refusal(asBob.createShareLink("use"))).toBe(NO_SHARING);

  // Carol, once a "use" member, only uses.
  await space.setMemberRole(carolName, "use");
  using asCarol = await carol.openGadget(id);
  expect(await asCarol.getMetadata()).toMatchObject({ id, role: "use" });
  expect(await refusal(asCarol.listChats())).toBe(USE_ONLY);

  // Neither became a collaborator, and the workspace joined neither's own list.
  expect(await workspace.listCollaborators()).toEqual([]);
  expect([...await bob.listGadgets(), ...await carol.listGadgets()]).toEqual([]);
});

it.concurrent("lowering a member, then removing them, ends the session they hold each time",
    async () => {
  using stack = new DisposableStack();
  const { aliceName, bobName, bob, key, space } = await team(stack);
  const bobId = await addMember(space, bobName, "build");
  const { workspace, id } = await workspaceIn(stack, aliceName, key);
  await activate(space, workspace, id);
  using building = await bob.openGadget(id);
  expect(await building.getMetadata()).toMatchObject({ role: "build" });

  // Lowered to "use", Bob loses the session he builds on, and the next one he opens only uses.
  await space.setMemberRole(bobName, "use");
  await severed(building);
  using viewing = await (await session(stack, bobName)).openGadget(id);
  expect(await viewing.getMetadata()).toMatchObject({ role: "use" });
  expect(await refusal(viewing.listChats())).toBe(USE_ONLY);

  // Removed, he loses that one too, and is refused from then on.
  await space.removeMember(bobId);
  await severed(viewing);
  expect(await refused(bobName, id)).toBe(true);
});

it.concurrent("a workspace its owner moves out of the space is closed to the space's members",
    async () => {
  using stack = new DisposableStack();
  const { aliceName, bobName, bob, key, space } = await team(stack);
  await space.setMemberRole(bobName, "build");
  const { workspace, id } = await workspaceIn(stack, aliceName, key);
  await activate(space, workspace, id);
  using asBob = await bob.openGadget(id);
  expect(await asBob.getMetadata()).toMatchObject({ role: "build" });

  // Back to Alice's personal space, which Bob is no member of.
  await workspace.moveToSpace(null);
  await severed(asBob);
  expect(await refused(bobName, id)).toBe(true);
});

// What `TestSession.readValue` is given to mark its observation with each of the two flags
// under which membership of a space gives no role.
it.concurrent.each([
  ["comes to hold restricted data", [true]],
  ["becomes owner-invites-only", [false, true]],
] as const)("a workspace that %s is closed to its space's members", async (_becomes, marked) => {
  using stack = new DisposableStack();
  const { aliceName, bobName, carolName, alice, bob, key, space } = await team(stack);
  await space.setMemberRole(bobName, "use");
  await space.setMemberRole(carolName, "build");
  await alice.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = await waitFor("the fixture account to be provisioned", async () =>
    (await listConnectedAccounts(alice)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
  const { workspace, id } = await workspaceIn(stack, aliceName, key);
  await activate(space, workspace, id);
  using connection = await workspace.newGatekeeper(
      account.id, `https://gadgets-test.example/things/${id}`);
  if (connection === null) throw new Error("Failed to create the test connection");
  using thing = await connection.openSession() as RpcStub<TestSession>;

  // The connection is bound to no gadget, so Bob, who only uses, has nothing to verify.
  using asBob = await bob.openGadget(id);
  expect(await asBob.getMetadata()).toMatchObject({ role: "use" });

  // The observation ends the session Bob holds, and from then on the workspace refuses him, and
  // Carol, a "build" member who never opened it.
  expect(await thing.readValue(...marked)).toBe(42);
  await severed(asBob);
  expect(await refused(bobName, id)).toBe(true);
  expect(await refused(carolName, id)).toBe(true);
});

it.concurrent("a member who is also a collaborator opens in the higher role, shares by their own "
    + "and keeps their own when removed from the space", async () => {
  using stack = new DisposableStack();
  const { aliceName, bobName, bob, key, space } = await team(stack);
  const bobId = await addMember(space, bobName, "build");
  const { workspace, id } = await workspaceIn(stack, aliceName, key);
  await activate(space, workspace, id);
  expect(await workspace.addCollaborator(bobName, "use")).toMatchObject({ role: "use" });

  // The space gives the higher role, so Bob builds, but he grants no more than "use".
  using building = await bob.openGadget(id);
  expect(await building.getMetadata()).toMatchObject({ role: "build" });
  expect(await refusal(building.createShareLink("build"))).toBe(ABOVE_OWN_ROLE);

  // Out of the space, he is left with what the workspace's own sharing gives him.
  await space.removeMember(bobId);
  await severed(building);
  using viewing = await (await session(stack, bobName)).openGadget(id);
  expect(await viewing.getMetadata()).toMatchObject({ role: "use" });
  expect(await refusal(viewing.listChats())).toBe(USE_ONLY);
});
