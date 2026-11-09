// A space member's role on the workspaces their space lists, end to end over the real RPC API:
// what a membership opens (the whole workspace to a "build" member, every gadget of it to a "use"
// member) and how that joins what the workspace's own sharing gives the same person, what it does
// not give (any power to share), and how a membership that ends, is lowered or stops applying
// reaches the sessions already open through it.
//
// A space tells a workspace that a role it gave no longer holds from its alarm, and the workspace
// then restarts, which ends every session that holds it. So Alice, who owns the workspace and
// administers the space in every test, changes the space on one session and holds the workspace
// on another, and whoever lost a session opens the workspace again on a new one. Four things
// are waited for with a bounded poll: the restart ending a session (`severed`); an open that has
// to be turned away, which the restart may cut short and so is tried again (`refused`, and
// `notFound` of a deleted workspace); a workspace's first listing, which follows its first
// activity (`activate`); and what a workspace tells others apart from the call that caused it,
// a collaborator's own record of it after they open it, and its removal from every record and
// listing after it is deleted. An open that has to succeed is made once and not polled for: after
// a restart, on a new session, once `severed` has seen the old one end.
//
// The fixture gatekeeper is bound for three things: recording an observation marked as restricted
// data or as owner-invites-only through a session on one of its connections
// (`TestSession.readValue`), giving a workspace or a gadget a connection that whoever gets it is
// verified for, and refusing an observer at one connection (`verify-outcome`).

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  getOpenWorkspaceErrorCode, OPEN_WORKSPACE_ERROR_CODES, type AuthenticatedApi,
  type OpenWorkspaceErrorCode, type Overseer, type Space, type SpaceMemberRole,
} from "@gadgets/workshop-shared/api";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  type Harness, settleRestart, startTestGatekeeperHarness, testControl, TEST_VENDOR_ID,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, connect, listConnectedAccounts, logIn, MAX_OBSERVER_PROMPTS, nextUsernames,
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

// The refusals the tests tell apart: of a call that takes "build", and of sharing by someone the
// workspace's own sharing does not let build.
const USE_ONLY = "Unauthorized: this collaborator only has permission to use the gadget's UI.";
const NO_SHARING = "You do not have permission to share this workspace.";

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
  const space = stack.use(await alice.createSpace("Crew"));
  const { id: spaceId } = await space.getInfo();
  return { aliceName, bobName, carolName, alice, bob, carol, spaceId, space };
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

/** A workspace of `ownerName`'s in the team space `spaceId`, held on a session of its own. */
async function workspaceIn(stack: DisposableStack, ownerName: string, spaceId: string) {
  const workspace = stack.use(await (await session(stack, ownerName)).newWorkspace(spaceId));
  return { workspace, id: (await workspace.getMetadata()).id };
}

/** Makes a gadget of `workspace`'s that belongs to no chat, and returns its id. */
async function newGadget(workspace: RpcStub<Overseer>, bindingName: string) {
  using gadget = workspace.createGadget("App", undefined, bindingName);
  return await gadget.getId();
}

/** The fixture account of `api`'s user, provisioned here. */
async function fixtureAccount(api: RpcStub<AuthenticatedApi>) {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the fixture account to be provisioned", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
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
 * Whether `username`, on a new session, is turned away from workspace `id` with `code`. An open
 * that the workspace's restart cuts short answers neither way, so it is tried again, for a
 * bounded time.
 */
const turnedAway = (code: OpenWorkspaceErrorCode) => (username: string, id: string) =>
  waitFor(`${username} to open workspace ${id} or be turned away from it`, async () => {
    using stack = new DisposableStack();
    try {
      stack.use(await (await session(stack, username)).openWorkspace(id));
      return false;
    } catch (error) {
      return getOpenWorkspaceErrorCode(error) === code || null;
    }
  });

/** Whether `username` is refused workspace `id`: it exists, and gives them nothing. */
const refused = turnedAway(OPEN_WORKSPACE_ERROR_CODES.workspaceAccessDenied);

/** Whether workspace `id` is not found for `username`, as one that was deleted is not. */
const notFound = turnedAway(OPEN_WORKSPACE_ERROR_CODES.workspaceNotFound);

it.concurrent("a member opens a listed workspace in the role of their membership, with no power "
    + "to share it, and nobody else opens it", async () => {
  using stack = new DisposableStack();
  const { aliceName, bobName, carolName, bob, carol, spaceId, space } = await team(stack);
  await space.setMemberRole(bobName, "build");
  const { workspace, id } = await workspaceIn(stack, aliceName, spaceId);

  // The space lists no workspace that has seen no activity, so it gives Bob no role on this one
  // yet. Carol is in no space of Alice's.
  expect(await refused(bobName, id)).toBe(true);
  await activate(space, workspace, id);
  expect(await refused(carolName, id)).toBe(true);
  const gadgetId = await newGadget(workspace, "APP");

  // Bob, a "build" member nobody shared the workspace with, builds.
  using asBob = await bob.openWorkspace(id);
  expect(await asBob.getMetadata()).toMatchObject({ id, role: "build" });
  expect(await asBob.listChats()).toHaveLength(1);
  // What he may share is decided by the workspace's own sharing, which gives him nothing: not the
  // workspace, nor one gadget of it, to a person or through a link.
  for (const grant of ["workspace", { gadgetId }] as const) {
    expect(await refusal(asBob.addCollaborator(carolName, grant))).toBe(NO_SHARING);
    expect(await refusal(asBob.createShareLink(grant))).toBe(NO_SHARING);
  }

  // Carol, once a "use" member, only uses: every gadget, though nobody shared one with her.
  await space.setMemberRole(carolName, "use");
  using asCarol = await carol.openWorkspace(id);
  expect(await asCarol.getMetadata()).toMatchObject({ id, role: "use" });
  expect(await refusal(asCarol.listChats())).toBe(USE_ONLY);
  using app = await asCarol.getGadget(gadgetId);
  expect(await app.getId()).toBe(gadgetId);

  // Neither became a collaborator, and the workspace joined neither's own list.
  expect(await workspace.listCollaborators()).toEqual([]);
  expect([...await bob.listWorkspaces(), ...await carol.listWorkspaces()]).toEqual([]);
});

it.concurrent("lowering a member, then removing them, ends the session they hold each time",
    async () => {
  using stack = new DisposableStack();
  const { aliceName, bobName, bob, spaceId, space } = await team(stack);
  const bobId = await addMember(space, bobName, "build");
  const { workspace, id } = await workspaceIn(stack, aliceName, spaceId);
  await activate(space, workspace, id);
  using building = await bob.openWorkspace(id);
  expect(await building.getMetadata()).toMatchObject({ role: "build" });

  // Lowered to "use", Bob loses the session he builds on, and the next one he opens only uses.
  await space.setMemberRole(bobName, "use");
  await severed(building);
  using viewing = await (await session(stack, bobName)).openWorkspace(id);
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
  const { aliceName, bobName, bob, spaceId, space } = await team(stack);
  await space.setMemberRole(bobName, "build");
  const { workspace, id } = await workspaceIn(stack, aliceName, spaceId);
  await activate(space, workspace, id);
  using asBob = await bob.openWorkspace(id);
  expect(await asBob.getMetadata()).toMatchObject({ role: "build" });

  // Back to Alice's personal space, which Bob is no member of.
  await workspace.moveToSpace(null);
  await severed(asBob);
  expect(await refused(bobName, id)).toBe(true);
});

// What `TestSession.readValue` is given to mark its observation with each of the two flags of a
// workspace, and the flag `Overseer.getMetadata()` then reports to whoever builds.
it.concurrent.each([
  ["comes to hold restricted data", [true], "containsRestrictedData"],
  ["becomes owner-invites-only", [false, true], "ownerInvitesOnly"],
] as const)("a workspace that %s stays open to its space's members, each verified as an observer",
    async (_becomes, marked, flag) => {
  using stack = new DisposableStack();
  const { aliceName, bobName, carolName, alice, bob, carol, spaceId, space } = await team(stack);
  await space.setMemberRole(bobName, "use");
  await space.setMemberRole(carolName, "build");
  const account = await fixtureAccount(alice);
  const carolAccount = await fixtureAccount(carol);
  const { workspace, id } = await workspaceIn(stack, aliceName, spaceId);
  await activate(space, workspace, id);
  const resourceUrl = `https://gadgets-test.example/things/${id}`;
  using connection = await workspace.newGatekeeper(account.id, resourceUrl);
  if (connection === null) throw new Error("Failed to create the test connection");
  const gatekeeperId = await connection.getId();
  using thing = await connection.openSession() as RpcStub<TestSession>;

  // The connection is bound to no gadget, so Bob, who only uses, has nothing to verify.
  using asBob = await bob.openWorkspace(id);
  expect(await asBob.getMetadata()).toMatchObject({ role: "use" });

  // The observation sets the flag, which Alice reads on the session she has held throughout, and
  // restarts nothing: the session Bob holds still answers. A session that only uses is told
  // neither flag, so his says the role alone.
  expect(await thing.readValue(...marked)).toBe(42);
  await settleRestart();
  expect(await workspace.getMetadata()).toMatchObject({ [flag]: true });
  expect(await asBob.getMetadata()).toMatchObject({ role: "use" });
  // The space lists the workspace as before, and his role opens it again.
  expect((await space.listWorkspaces()).map(entry => entry.id)).toContain(id);
  {
    using again = await bob.openWorkspace(id);
    expect(await again.getMetadata()).toMatchObject({ role: "use" });
  }

  // Carol builds as a member, so she is verified for what the workspace reads, as a collaborator
  // who builds is. With nothing to answer a prompt she is turned away at that gate, which is not
  // how someone the workspace gives nothing is refused.
  expect(await refusal(carol.openWorkspace(id))).toMatch(/connected accounts/);

  // The connection refuses her account: she is asked for as long as an open asks, and refused in
  // the connection's words, with that one connection marked as the failure.
  const reason = `The test refused this member at workspace ${id}.`;
  const label = accountLabel(carolAccount);
  await testControl(requireHarness(), "verify-outcome",
      { label, resourceUrl, allow: false, reason });
  {
    const recorder = new ObserverConfigRecorder()
        .alwaysChoose(carolAccount.id, MAX_OBSERVER_PROMPTS);
    using callback = stubFor(recorder);
    expect(await refusal(carol.openWorkspace(id, undefined, callback))).toContain(reason);
    expect(recorder.calls.at(-1)!.filter(need => need.failure)).toEqual([
      expect.objectContaining({ gatekeeperId }),
    ]);
  }

  // Once it admits her, she builds, having been asked about that connection, and is told the flag.
  await testControl(requireHarness(), "verify-outcome", { label, resourceUrl, allow: true });
  const recorder = new ObserverConfigRecorder().alwaysChoose(carolAccount.id, MAX_OBSERVER_PROMPTS);
  using callback = stubFor(recorder);
  using asCarol = await carol.openWorkspace(id, undefined, callback);
  expect(await asCarol.getMetadata()).toMatchObject({ role: "build", [flag]: true });
  expect(recorder.calls[0]).toContainEqual(expect.objectContaining({ gatekeeperId }));

  // Admitting a member restarts nobody: Bob still holds his first session.
  await settleRestart();
  expect(await asBob.getMetadata()).toMatchObject({ role: "use" });
});

it.concurrent("a member who is also a collaborator opens with what either gives, shares by their "
    + "own access alone and keeps it when removed from the space", async () => {
  using stack = new DisposableStack();
  const { aliceName, bobName, carolName, bob, spaceId, space } = await team(stack);
  const bobId = await addMember(space, bobName, "build");
  const { workspace, id } = await workspaceIn(stack, aliceName, spaceId);
  await activate(space, workspace, id);
  const shared = await newGadget(workspace, "SHARED");
  const other = await newGadget(workspace, "OTHER");
  expect(await workspace.addCollaborator(bobName, { gadgetId: shared }))
      .toMatchObject({ access: { role: "use", gadgetIds: [shared] } });

  // The space lets Bob build. His own access is "use" of one gadget, which grants nothing, not
  // even that gadget.
  using building = await bob.openWorkspace(id);
  expect(await building.getMetadata()).toMatchObject({ role: "build" });
  expect(await refusal(building.createShareLink("workspace"))).toBe(NO_SHARING);
  expect(await refusal(building.addCollaborator(carolName, { gadgetId: shared })))
      .toBe(NO_SHARING);
  // His own list records the workspace with the role its sharing gives him, not the space's.
  const record = await waitFor("the workspace in the collaborator's own list", async () =>
    (await bob.listWorkspaces()).find(entry => entry.id === id) ?? null);
  expect(record).toMatchObject({ role: "use" });

  // Out of the space, he is left with what the workspace's own sharing gives him: the one gadget.
  await space.removeMember(bobId);
  await severed(building);
  using viewing = await (await session(stack, bobName)).openWorkspace(id);
  expect(await viewing.getMetadata()).toMatchObject({ role: "use" });
  expect(await refusal(viewing.listChats())).toBe(USE_ONLY);
  using app = await viewing.getGadget(shared);
  expect(await app.getId()).toBe(shared);
  expect(await refusal(viewing.getGadget(other))).toBe(`No such gadget: ${other}`);
});

it.concurrent("a member who uses and was also given one gadget reaches every gadget, and only "
    + "that one once out of the space", async () => {
  using stack = new DisposableStack();
  const { aliceName, carolName, carol, spaceId, space } = await team(stack);
  const carolId = await addMember(space, carolName, "use");
  const { workspace, id } = await workspaceIn(stack, aliceName, spaceId);
  await activate(space, workspace, id);
  const shared = await newGadget(workspace, "SHARED");
  const other = await newGadget(workspace, "OTHER");
  await workspace.addCollaborator(carolName, { gadgetId: shared });

  // The space gives her every gadget, the one she was given and the one she was not.
  using asMember = await carol.openWorkspace(id);
  expect(await asMember.getMetadata()).toMatchObject({ role: "use" });
  for (const gadgetId of [shared, other]) {
    using app = await asMember.getGadget(gadgetId);
    expect(await app.getId()).toBe(gadgetId);
  }

  // Out of the space, she still uses, and gets the gadget she was given and no other.
  await space.removeMember(carolId);
  await severed(asMember);
  using asCollaborator = await (await session(stack, carolName)).openWorkspace(id);
  expect(await asCollaborator.getMetadata()).toMatchObject({ role: "use" });
  using app = await asCollaborator.getGadget(shared);
  expect(await app.getId()).toBe(shared);
  expect(await refusal(asCollaborator.getGadget(other))).toBe(`No such gadget: ${other}`);
});

it.concurrent("a member who uses is verified for the gadget they get, as a collaborator given it "
    + "is", async () => {
  using stack = new DisposableStack();
  const { aliceName, carolName, alice, carol, spaceId, space } = await team(stack);
  await space.setMemberRole(carolName, "use");
  const account = await fixtureAccount(alice);
  const carolAccount = await fixtureAccount(carol);
  const { workspace, id } = await workspaceIn(stack, aliceName, spaceId);
  await activate(space, workspace, id);

  // A gadget that reaches a connection of Alice's, bound before Carol holds anything, so that
  // the binding restarts nobody.
  using gadget = workspace.createGadget("App", undefined, "APP");
  const gadgetId = await gadget.getId();
  using connection = await workspace.newGatekeeper(
      account.id, `https://gadgets-test.example/things/${id}`);
  if (connection === null) throw new Error("Failed to create the test connection");
  const gatekeeperId = await connection.getId();
  await gadget.bind("THING", gatekeeperId);

  // With nothing to answer a prompt, she opens the workspace, where nothing is verified, and is
  // refused the gadget, which reaches a connection she has chosen no account for.
  {
    using unverified = await carol.openWorkspace(id);
    expect(await unverified.getMetadata()).toMatchObject({ role: "use" });
    expect(await refusal(unverified.getGadget(gadgetId))).toMatch(/connected accounts/);
  }

  // Able to answer, she is asked once, when she gets the gadget, about that one connection.
  const recorder = new ObserverConfigRecorder().alwaysChoose(carolAccount.id, 1);
  using callback = stubFor(recorder);
  using verified = await carol.openWorkspace(id, undefined, callback);
  expect(await verified.getMetadata()).toMatchObject({ role: "use" });
  expect(recorder.callCount).toBe(0);
  using app = await verified.getGadget(gadgetId, callback);
  expect(await app.getId()).toBe(gadgetId);
  expect(recorder.callCount).toBe(1);
  expect(recorder.calls[0]).toHaveLength(1);
  expect(recorder.needAt(0)).toMatchObject({ gatekeeperId });
});

it.concurrent("a workspace its owner deletes leaves the listing and is closed to the space's "
    + "members", async () => {
  using stack = new DisposableStack();
  const { aliceName, bobName, carolName, bob, carol, spaceId, space } = await team(stack);
  await space.setMemberRole(bobName, "build");
  const { workspace, id } = await workspaceIn(stack, aliceName, spaceId);
  await activate(space, workspace, id);
  const lists = async (api: RpcStub<AuthenticatedApi>) =>
    (await api.listWorkspaces()).some(entry => entry.id === id);

  // Carol, in no space, is a collaborator who has opened the workspace, so her own list has it:
  // a second record of it, beside its owner's, for the deletion to remove.
  await workspace.addCollaborator(carolName, "workspace");
  {
    using asCarol = await carol.openWorkspace(id);
    expect(await asCarol.getMetadata()).toMatchObject({ role: "build" });
  }
  await waitFor("the workspace in the collaborator's own list", async () =>
    await lists(carol) || null);

  // Bob holds a session through the space, so the space holds a lease of his to revoke.
  using asBob = await bob.openWorkspace(id);
  expect(await asBob.getMetadata()).toMatchObject({ role: "build" });

  // The space revokes that lease as the owner's record leaves it, while the workspace is still
  // removing itself from the others: the deletion is not cut short, and its call returns.
  await workspace.deleteSelf();
  await severed(asBob);
  await waitFor("the deleted workspace to leave the space's listing", async () =>
    (await space.listWorkspaces()).every(entry => entry.id !== id) || null);
  await waitFor("the deleted workspace to leave the collaborator's own list", async () =>
    !await lists(carol) || null);
  expect(await notFound(bobName, id)).toBe(true);
});
