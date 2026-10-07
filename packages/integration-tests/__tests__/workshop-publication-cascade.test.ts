// A publication held back by the tree of its space's listing, end to end over the real RPC API: a
// published workspace admits anyone signed in only while every workspace above it in that tree
// is published too. Who is refused while one above it is not, and with what; what the owner is
// told of the workspace that holds it back; what publishing that one opens, and what
// unpublishing it again does to the sessions opened through it; and that a member of the space
// opens such a workspace in their own role all the same.
//
// Alice owns every workspace. Bob, in the first test, is in no space of hers, so whatever he
// reaches he reaches through a publication; in the second he is a member of a team space of
// hers, and Carol is the one outside it. A workspace's restart ends every session it is held on,
// so each workspace is held on a session of its own, apart from the sessions that read the
// space. Two things are waited for with a bounded poll, as in workshop-published.test.ts: the
// restart ending a session (`severed`), and the outcome of an open, which a restart may cut
// short (`settledOpen`). `setPublicAccess` brings the space's listing up to date before it
// returns, so the listing is read back directly.

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  getOpenGadgetErrorCode, OPEN_GADGET_ERROR_CODES, slugify, type AuthenticatedApi, type Overseer,
  type Space,
} from "@gadgets/workshop-shared/api";
import { type Harness, startTestGatekeeperHarness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, nextUsernames, signUp, waitFor } from "../src/rpc-client.js";

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

const { workspaceAccessDenied, workspaceNotVisible } = OPEN_GADGET_ERROR_CODES;

/** A new account `username`, signed up on a session of its own that `stack` owns. */
async function account(stack: DisposableStack, username: string)
    : Promise<RpcStub<AuthenticatedApi>> {
  return stack.use(await signUp(stack.use(connect(requireHarness().url)), username));
}

/** A session for the existing account `username`; `stack` owns it. */
async function session(stack: DisposableStack, username: string)
    : Promise<RpcStub<AuthenticatedApi>> {
  return stack.use(await logIn(stack.use(connect(requireHarness().url)), username));
}

/**
 * A workspace of `ownerName`'s under `title`, in team space `key` or, without one, in the owner's
 * personal space, created under `parentId` if one is given, held on a session of its own, once
 * `space` lists it: after its first activity, which a chat that starts no agent is the cheapest
 * thing to count as, and polled for, for a bounded time. A restart of the workspace ends the
 * whole session it is held on, so no other stub shares it.
 */
async function listedWorkspace(
    stack: DisposableStack, ownerName: string, key: string | undefined, space: RpcStub<Space>,
    title: string, parentId?: string) {
  const workspace = stack.use(await (await session(stack, ownerName)).newGadget(key, parentId));
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
 * What `username`, on a new session, gets on opening workspace `id`: "opened", or the code it is
 * refused with. An open the workspace's restart cuts short carries no code and answers neither
 * way, so it is tried again, for a bounded time.
 */
const settledOpen = (username: string, id: string) =>
  waitFor(`${username} to open workspace ${id} or be refused it`, async () => {
    using stack = new DisposableStack();
    try {
      stack.use(await (await session(stack, username)).openGadget(id));
      return "opened";
    } catch (error) {
      return getOpenGadgetErrorCode(error) ?? null;
    }
  });

/** The entry of workspace `id` in `space`'s listing, as its caller is shown it. */
async function entryOf(space: RpcStub<Space>, id: string) {
  const entry = (await space.listWorkspaces()).find(listed => listed.id === id);
  if (entry === undefined) throw new Error(`Workspace ${id} is not in the listing`);
  return entry;
}

it.concurrent("a published workspace under an unpublished one admits nobody through its "
    + "publication until that one is published, and stops again when it is not", async () => {
  using stack = new DisposableStack();
  const [aliceName, bobName] = nextUsernames("alice", "bob");
  const alice = await account(stack, aliceName);
  const bob = await account(stack, bobName);
  const [personal] = await alice.listSpaces();
  if (personal?.kind !== "personal") throw new Error("Alice's listing led with no personal space");
  using space = await alice.openSpace(personal.key);

  // In Alice's personal space: a published workspace at the top, which opens the space to Bob as
  // a visitor, and an unpublished Handbook with a published Holidays under it.
  //   Notice Board+
  //   Handbook ── Holidays+
  const notice = await listedWorkspace(stack, aliceName, undefined, space, "Notice Board");
  const parent = await listedWorkspace(stack, aliceName, undefined, space, "Handbook");
  const child = await listedWorkspace(stack, aliceName, undefined, space, "Holidays", parent.id);
  expect(child.entry.parentId).toBe(parent.id);
  await notice.workspace.setPublicAccess("use");
  await child.workspace.setPublicAccess("use");

  // Bob is refused Holidays, by the id he holds, as published but not visible: by a message
  // that names neither the workspace that holds it back nor this one. Handbook he is refused
  // as any unpublished workspace is.
  expect(await settledOpen(bobName, child.id)).toBe(workspaceNotVisible);
  const message = await refusal(bob.openGadget(child.id));
  for (const named of [parent.id, child.id, "Handbook", "Holidays"]) {
    expect(message).not.toContain(named);
  }
  expect(await settledOpen(bobName, parent.id)).toBe(workspaceAccessDenied);
  expect(await settledOpen(bobName, notice.id)).toBe("opened");

  // As a visitor of the space he is shown the Notice Board alone, and resolves Holidays by no
  // slug.
  using visiting = await bob.openSpace(personal.key);
  expect((await visiting.listWorkspaces()).map(({ id }) => id)).toEqual([notice.id]);
  expect(await visiting.resolveWorkspace(slugify("Holidays"))).toBeNull();

  // Alice, the space's owner, is told which workspace holds Holidays back. Neither of the others
  // is held back: the Notice Board has nothing above it, and Handbook is not published.
  expect(await entryOf(space, child.id))
      .toMatchObject({ published: "use", hiddenBy: parent.id });
  expect(await entryOf(space, parent.id)).not.toHaveProperty("hiddenBy");
  expect(await entryOf(space, notice.id)).not.toHaveProperty("hiddenBy");

  // Handbook published, Bob opens both, through the publication, and is shown both. Each is
  // held on a session of its own, so that the end of the one on Holidays below is that
  // workspace's own restart and not Handbook's.
  await parent.workspace.setPublicAccess("use");
  expect(await entryOf(space, child.id)).not.toHaveProperty("hiddenBy");
  using openedParent = await (await session(stack, bobName)).openGadget(parent.id);
  expect(await openedParent.getMetadata()).toMatchObject({ id: parent.id, role: "use" });
  using openedChild = await (await session(stack, bobName)).openGadget(child.id);
  expect(await openedChild.getMetadata()).toMatchObject({ id: child.id, role: "use" });
  expect((await visiting.listWorkspaces()).map(({ id }) => id))
      .toEqual([notice.id, parent.id, child.id]);

  // Handbook unpublished again, the session Bob holds on Holidays ends with the restart its
  // space's revocation causes, and from then on he is refused it as not visible, while Alice is
  // told again what holds it back.
  await parent.workspace.setPublicAccess(null);
  expect(await entryOf(space, child.id))
      .toMatchObject({ published: "use", hiddenBy: parent.id });
  await severed(openedChild);
  expect(await settledOpen(bobName, child.id)).toBe(workspaceNotVisible);
  expect(await settledOpen(bobName, parent.id)).toBe(workspaceAccessDenied);
  expect((await visiting.listWorkspaces()).map(({ id }) => id)).toEqual([notice.id]);

  // Holidays is still published: only the workspace above it changed.
  using reopened = await (await session(stack, aliceName)).openGadget(child.id);
  expect(await reopened.getMetadata()).toMatchObject({ publicAccess: "use" });
});

it.concurrent("a member of the space opens a published workspace that one above it holds back, "
    + "in the role their membership gives, and no higher", async () => {
  using stack = new DisposableStack();
  const [aliceName, bobName, carolName] = nextUsernames("alice", "bob", "carol");
  const alice = await account(stack, aliceName);
  const bob = await account(stack, bobName);
  await account(stack, carolName);
  // Unique for the harness's lifetime, as the usernames are. The dash is part of the key grammar.
  const key = `team-${aliceName}`;
  using space = await alice.createSpace(key, "Crew");
  await space.setMemberRole(bobName, "use");

  //   Handbook ── Holidays+ (published to build)
  const parent = await listedWorkspace(stack, aliceName, key, space, "Handbook");
  const child = await listedWorkspace(stack, aliceName, key, space, "Holidays", parent.id);
  await child.workspace.setPublicAccess("build");

  // Bob, a member, is shown what holds it back, as Alice is, and opens it in his membership's
  // "use", not the "build" it is published with, which is not in effect.
  using asBob = await bob.openSpace(key);
  expect(await entryOf(asBob, child.id))
      .toMatchObject({ published: "build", hiddenBy: parent.id });
  expect(await entryOf(space, child.id))
      .toMatchObject({ published: "build", hiddenBy: parent.id });
  using opened = await (await session(stack, bobName)).openGadget(child.id);
  expect(await opened.getMetadata()).toMatchObject({ id: child.id, role: "use" });
  // Carol, who is not a member, is refused it as published but not visible.
  expect(await settledOpen(carolName, child.id)).toBe(workspaceNotVisible);

  // Handbook published, the publication takes effect for both: Bob's next session builds, and
  // Carol opens.
  await parent.workspace.setPublicAccess("use");
  using building = await (await session(stack, bobName)).openGadget(child.id);
  expect(await building.getMetadata()).toMatchObject({ id: child.id, role: "build" });
  expect(await settledOpen(carolName, child.id)).toBe("opened");
});
