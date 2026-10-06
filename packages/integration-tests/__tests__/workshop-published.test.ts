// A workspace published to the whole deployment, end to end over the real RPC API: who opens it
// through the publication and in which role, what that role does not give (any power to share or
// to publish), how withdrawing or lowering it reaches the sessions already open through it, what
// becomes of it when the workspace comes to hold restricted data, and what a space shows someone
// who is not its member while it lists a published workspace.
//
// Alice owns the workspace and administers its space in every test, and Bob is a member of that
// space. Carol is neither a member nor a collaborator: whatever she reaches, she reaches through
// the publication. Withdrawing or lowering it restarts the workspace, which ends every session of
// it, Alice's too, so whoever needs one after that opens it again on a new session. Two things are
// waited for with a bounded poll, as in workshop-space-roles.test.ts: the restart ending a session
// (`severed`), and an open that has to be refused, which the restart may cut short and so is
// tried again (`refused`). `setPublicAccess` brings the owner's record and the space's listing up
// to date before it returns, so those are read back directly.
//
// The fixture gatekeeper is bound for one thing: recording an observation marked as restricted
// data or as owner-invites-only through a session on one of its connections
// (`TestSession.readValue`).

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  getOpenGadgetErrorCode, OPEN_GADGET_ERROR_CODES, slugify, type AuthenticatedApi, type Overseer,
  type Space,
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
// workspace's own sharing gives no role, of publishing by anyone but the owner, and of publishing
// a workspace under a restriction flag.
const USE_ONLY = "Unauthorized: this collaborator only has permission to use the gadget's UI.";
const NO_SHARING = "You do not have permission to share this workspace.";
const OWNER_ONLY = /only the workspace owner/i;
const NOT_PUBLISHABLE = /cannot be published/i;

/** A session for the existing account `username`; `stack` owns it. */
async function session(stack: DisposableStack, username: string)
    : Promise<RpcStub<AuthenticatedApi>> {
  return stack.use(await logIn(stack.use(connect(requireHarness().url)), username));
}

/**
 * Alice, Bob and Carol, each signed up on a session of their own, and a team space of Alice's
 * with Bob in it as a "use" member.
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
  await space.setMemberRole(bobName, "use");
  return { aliceName, bobName, carolName, alice, bob, carol, key, space };
}

/**
 * A workspace of `ownerName`'s in team space `key` under `title`, held on a session of its own,
 * once `space` lists it: after its first activity, which a chat that starts no agent is the
 * cheapest thing to count as, and polled for, for a bounded time.
 */
async function listedWorkspace(
    stack: DisposableStack, ownerName: string, key: string, space: RpcStub<Space>, title: string) {
  const workspace = stack.use(await (await session(stack, ownerName)).newGadget(key));
  const { id } = await workspace.getMetadata();
  await workspace.setTitle(title);
  await workspace.newChat("Seen activity, with no agent", null);
  const entry = await waitFor(`workspace "${title}" in the space's listing`, async () =>
    (await space.listWorkspaces()).find(listed => listed.id === id && listed.title === title)
        ?? null);
  return { workspace, id, entry };
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

/** The owner's own record of workspace `id`. */
async function ownRecord(api: RpcStub<AuthenticatedApi>, id: string) {
  const record = (await api.listGadgets()).find(gadget => gadget.id === id);
  if (record === undefined) throw new Error(`Workspace ${id} is not in its owner's list`);
  return record;
}

it.concurrent("anyone signed in opens a published workspace in its role, with no power to share "
    + "or publish it", async () => {
  using stack = new DisposableStack();
  const { aliceName, bobName, carolName, alice, bob, carol, key, space } = await team(stack);
  const { workspace, id } = await listedWorkspace(stack, aliceName, key, space, "Roadmap");
  expect(await refused(carolName, id)).toBe(true);

  // Published at "use", Carol only uses, and may not publish.
  await workspace.setPublicAccess("use");
  using viewing = await carol.openGadget(id);
  expect(await viewing.getMetadata()).toMatchObject({ id, role: "use" });
  expect(await refusal(viewing.listChats())).toBe(USE_ONLY);
  expect(await refusal(viewing.setPublicAccess(null))).toBe(USE_ONLY);

  // Raised to "build", her next session builds. The owner's record and the space's listing say
  // so by the time the call returns. That raising restarts nobody is pinned by the kernel's own
  // test (workshop-backend's spaces-published.test.ts): nothing here is ordered after the
  // restart it would schedule, so a check of the session she holds could not fail.
  await workspace.setPublicAccess("build");
  expect(await workspace.getMetadata()).toMatchObject({ publicAccess: "build" });
  expect(await ownRecord(alice, id)).toMatchObject({ publicAccess: "build" });
  expect((await space.listWorkspaces()).find(entry => entry.id === id))
      .toMatchObject({ published: "build" });
  using building = await (await session(stack, carolName)).openGadget(id);
  expect(await building.getMetadata()).toMatchObject({ id, role: "build" });
  expect(await building.listChats()).toHaveLength(1);
  // What she may share is decided by the workspace's own sharing, which gives her nothing, and
  // only its owner publishes it.
  expect(await refusal(building.addCollaborator(bobName, "use"))).toBe(NO_SHARING);
  expect(await refusal(building.createShareLink("use"))).toBe(NO_SHARING);
  expect(await refusal(building.setPublicAccess(null))).toMatch(OWNER_ONLY);

  // Bob, a "use" member, opens in the higher of his membership and the publication; as a
  // collaborator besides, he may share but still not publish.
  using asMember = await bob.openGadget(id);
  expect(await asMember.getMetadata()).toMatchObject({ role: "build" });
  expect(await refusal(asMember.setPublicAccess(null))).toMatch(OWNER_ONLY);
  await workspace.addCollaborator(bobName, "build");
  using asCollaborator = await (await session(stack, bobName)).openGadget(id);
  expect(await refusal(asCollaborator.setPublicAccess(null))).toMatch(OWNER_ONLY);
  expect(await workspace.getMetadata()).toMatchObject({ publicAccess: "build" });

  // Carol became no collaborator, and the workspace joined no list of hers.
  expect((await workspace.listCollaborators()).map(({ profile }) => profile.id))
      .toEqual([bobName]);
  expect(await carol.listGadgets()).toEqual([]);
});

it.concurrent("lowering the publication, then withdrawing it, ends the session opened through it "
    + "each time", async () => {
  using stack = new DisposableStack();
  const { aliceName, carolName, carol, key, space } = await team(stack);
  const { workspace, id } = await listedWorkspace(stack, aliceName, key, space, "Roadmap");
  await workspace.setPublicAccess("build");
  using building = await carol.openGadget(id);
  expect(await building.getMetadata()).toMatchObject({ role: "build" });

  // Lowered to "use", Carol loses the session she builds on, and the next one she opens only uses.
  await workspace.setPublicAccess("use");
  await severed(building);
  using viewing = await (await session(stack, carolName)).openGadget(id);
  expect(await viewing.getMetadata()).toMatchObject({ role: "use" });
  expect(await refusal(viewing.listChats())).toBe(USE_ONLY);

  // Withdrawn, by the owner on a session of her own since the restart, she loses that one too,
  // and is refused from then on.
  using reopened = await (await session(stack, aliceName)).openGadget(id);
  await reopened.setPublicAccess(null);
  await severed(viewing);
  expect(await refused(carolName, id)).toBe(true);
  using after = await (await session(stack, aliceName)).openGadget(id);
  expect((await after.getMetadata()).publicAccess).toBeUndefined();
});

// What `TestSession.readValue` is given to mark its observation with each of the two flags
// under which a workspace is not published.
it.concurrent.each([
  ["comes to hold restricted data", [true], "containsRestrictedData"],
  ["becomes owner-invites-only", [false, true], "ownerInvitesOnly"],
] as const)("a published workspace that %s is published no longer, and cannot be again",
    async (_becomes, marked, flag) => {
  using stack = new DisposableStack();
  const { aliceName, carolName, alice, carol, key, space } = await team(stack);
  await alice.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = await waitFor("the fixture account to be provisioned", async () =>
    (await listConnectedAccounts(alice)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
  const { workspace, id } = await listedWorkspace(stack, aliceName, key, space, "Ledger");
  using connection = await workspace.newGatekeeper(
      account.id, `https://gadgets-test.example/things/${id}`);
  if (connection === null) throw new Error("Failed to create the test connection");
  using thing = await connection.openSession() as RpcStub<TestSession>;
  await workspace.setPublicAccess("use");

  // The connection is bound to no gadget, so Carol, who only uses, has nothing to verify.
  using viewing = await carol.openGadget(id);
  expect(await viewing.getMetadata()).toMatchObject({ role: "use" });

  // The observation withdraws the publication: it ends the session Carol holds, and from then
  // on the workspace refuses her.
  expect(await thing.readValue(...marked)).toBe(42);
  await severed(viewing);
  expect(await refused(carolName, id)).toBe(true);

  // The workspace says so, and so does Alice's record once the workspace next reports to it.
  using reopened = await (await session(stack, aliceName)).openGadget(id);
  const metadata = await reopened.getMetadata();
  expect(metadata[flag]).toBe(true);
  expect(metadata.publicAccess).toBeUndefined();
  await reopened.setTitle("Ledger, from the data");
  const record = await waitFor(`Alice's record to show ${flag}`, async () => {
    const own = await ownRecord(alice, id);
    return own[flag] ? own : null;
  });
  expect(record.publicAccess).toBeUndefined();

  // Nor can she publish it again, at either role, nor even withdraw what is not there.
  for (const role of ["use", "build", null] as const) {
    expect(await refusal(reopened.setPublicAccess(role)), String(role)).toMatch(NOT_PUBLISHABLE);
  }
  expect((await reopened.getMetadata()).publicAccess).toBeUndefined();
});

it.concurrent("someone who is not a member sees of a space only the published workspaces it lists, "
    + "and only while it lists one", async () => {
  using stack = new DisposableStack();
  const { aliceName, carolName, carol, key, space } = await team(stack);
  const published = await listedWorkspace(stack, aliceName, key, space, "Launch Plan");
  const unpublished = await listedWorkspace(stack, aliceName, key, space, "Private Notes");
  const unclaimed = await refusal(carol.openSpace(`free-${carolName}`));
  const carolSpaces = await carol.listSpaces();
  expect(carolSpaces).toHaveLength(1);

  // While nothing in it is published, the space refuses Carol as a key nobody claimed does,
  // though it lists two workspaces.
  expect(await refusal(carol.openSpace(key))).toBe(unclaimed);

  // Once one is, she opens it as a visitor: its info with no role, and of its listing that one
  // workspace alone, by whose slug she finds it, and by no other slug.
  await published.workspace.setPublicAccess("use");
  using visiting = await carol.openSpace(key);
  expect(await visiting.getInfo()).toEqual({ key, name: "Crew", kind: "team" });
  const entry = { ...published.entry, published: "use" };
  expect(await visiting.listWorkspaces()).toEqual([entry]);
  expect(await visiting.resolveWorkspace(slugify("Launch Plan")))
      .toEqual({ workspace: entry, canonical: true });
  expect(await visiting.resolveWorkspace(slugify("Private Notes"))).toBeNull();
  expect(unpublished.entry.slug).toBe(slugify("Private Notes"));
  // Given another address, it is found by the slug it had too.
  const readdressed = await space.setWorkspaceSlug(published.id, "launch");
  expect(readdressed).toMatchObject({ slug: "launch", published: "use" });
  expect(await visiting.resolveWorkspace(slugify("Launch Plan")))
      .toEqual({ workspace: readdressed, canonical: false });
  expect(await visiting.resolveWorkspace("launch"))
      .toEqual({ workspace: readdressed, canonical: true });
  // Everything else of the space is refused her, as an unclaimed key is.
  expect(await refusal(visiting.listMembers())).toBe(unclaimed);
  expect(await refusal(visiting.setMemberRole(carolName, "admin"))).toBe(unclaimed);
  expect(await refusal(visiting.removeMember(carolName))).toBe(unclaimed);
  expect(await refusal(visiting.setWorkspaceSlug(published.id, "taken-over"))).toBe(unclaimed);
  // The space's members still see both workspaces, and Carol is not one of them.
  expect((await space.listWorkspaces()).map(({ id }) => id).toSorted())
      .toEqual([published.id, unpublished.id].toSorted());
  expect((await space.listMembers()).map(({ profile }) => profile.id)).not.toContain(carolName);
  expect(await carol.listSpaces()).toEqual(carolSpaces);

  // Withdrawn, it leaves the space with nothing published, and the stub she holds refuses her
  // as a new open does.
  await published.workspace.setPublicAccess(null);
  expect(await refusal(visiting.getInfo())).toBe(unclaimed);
  expect(await refusal(visiting.listWorkspaces())).toBe(unclaimed);
  expect(await refusal(carol.openSpace(key))).toBe(unclaimed);
  expect(await carol.listSpaces()).toEqual(carolSpaces);
});
