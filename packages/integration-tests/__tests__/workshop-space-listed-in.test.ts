// Which space lists a workspace, as its metadata says (`GadgetMetadata.listedIn`), end to end over
// the real RPC API: the owner, a direct collaborator in either role and a visitor who opens the
// workspace through its publication are all told the same key, the owner's personal space's or
// a team space's, including one none of them but the owner is a member of; and an open
// subscription to the metadata is told when the owner moves the workspace.
//
// Alice owns every workspace. A workspace is listed once its space has acknowledged its first
// activity, which follows that activity apart from the call that caused it, so that, and only
// that, is polled for with a bounded wait (`listedIn`). A move is finished when its call
// returns, so what an open after it says is read directly. Moving a published workspace takes
// back the visibility its publication had and restarts it for whoever opened it through that,
// which ends every session it is held on, so after such a move each reader opens it again on a
// new session, retried for a bounded time in case the restart cuts the open short
// (`openedMetadata`). No publication is involved where a subscription has to outlive a move.

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuthenticatedApi, GadgetMetadata, Overseer } from "@gadgets/workshop-shared/api";
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

/** A new account `username` on a session of its own that `stack` owns. */
async function account(stack: DisposableStack, username: string)
    : Promise<RpcStub<AuthenticatedApi>> {
  return stack.use(await signUp(stack.use(connect(requireHarness().url)), username));
}

/** A session for the existing account `username`; `stack` owns it. */
async function session(stack: DisposableStack, username: string)
    : Promise<RpcStub<AuthenticatedApi>> {
  return stack.use(await logIn(stack.use(connect(requireHarness().url)), username));
}

/** The key of the caller's personal space: the first entry of their listing. */
async function personalKeyOf(api: RpcStub<AuthenticatedApi>): Promise<string> {
  const [personal] = await api.listSpaces();
  if (personal?.kind !== "personal") throw new Error("The listing led with no personal space");
  return personal.key;
}

/**
 * A new workspace of `ownerName`'s in their personal space, held on a session of its own, given
 * its first activity: a chat that starts no agent is the cheapest thing that counts as that.
 */
async function activeWorkspace(stack: DisposableStack, ownerName: string) {
  const workspace = stack.use(await (await session(stack, ownerName)).newGadget());
  const { id, listedIn } = await workspace.getMetadata();
  // Not yet active, the workspace is in no space's listing, so its metadata names none.
  expect(listedIn).toBeUndefined();
  await workspace.newChat("Seen activity, with no agent", null);
  return { workspace, id };
}

/** Polls, for a bounded time, until `workspace`'s metadata says space `key` lists it. */
const listedIn = (workspace: RpcStub<Overseer>, key: string) =>
  waitFor(`the workspace's metadata to name space ${key}`, async () => {
    const metadata = await workspace.getMetadata();
    return metadata.listedIn === key ? metadata : null;
  });

/**
 * The metadata `username` gets on opening workspace `id` on a new session. An open that the
 * workspace's restart cuts short is tried again, for a bounded time.
 */
const openedMetadata = (username: string, id: string) =>
  waitFor(`${username} to open workspace ${id}`, async () => {
    using stack = new DisposableStack();
    try {
      const workspace = stack.use(await (await session(stack, username)).openGadget(id));
      return await workspace.getMetadata();
    } catch {
      return null;
    }
  });

it.concurrent("the owner, a collaborator and a visitor of a published workspace are all told "
    + "the space that lists it, before and after its owner moves it", async () => {
  using stack = new DisposableStack();
  const [aliceName, bobName, carolName] = nextUsernames("alice", "bob", "carol");
  const alice = await account(stack, aliceName);
  const bob = await account(stack, bobName);
  const carol = await account(stack, carolName);
  const personal = await personalKeyOf(alice);
  // Unique for the harness's lifetime, as the usernames are. The dash is part of the key grammar.
  const team = `team-${aliceName}`;
  using space = await alice.createSpace(team, "Crew");

  // In Alice's personal space, shared with Bob directly and published to everyone signed in.
  const { workspace, id } = await activeWorkspace(stack, aliceName);
  await listedIn(workspace, personal);
  expect(await workspace.addCollaborator(bobName, "use")).toMatchObject({ role: "use" });
  await workspace.setPublicAccess("use");

  // Bob, through his own grant, and Carol, through the publication, are told it is Alice's
  // personal space, though neither is a member of it, in what each opens it with.
  using asBob = await bob.openGadget(id);
  expect(await asBob.getMetadata()).toMatchObject({ role: "use", listedIn: personal });
  using asCarol = await carol.openGadget(id);
  expect(await asCarol.getMetadata()).toMatchObject({ role: "use", listedIn: personal });

  // Moved into the team space, of which Alice is the only member, every reader who opens it
  // again is told the team space, Carol too, since the publication applies there as well.
  await workspace.moveToSpace(team);
  expect((await space.listWorkspaces()).map(entry => entry.id)).toEqual([id]);
  for (const username of [aliceName, bobName, carolName]) {
    expect(await openedMetadata(username, id), username).toMatchObject({ listedIn: team });
  }
});

it.concurrent("a collaborator's open subscription is told each space the workspace moves to",
    async () => {
  using stack = new DisposableStack();
  const [aliceName, bobName, carolName] = nextUsernames("alice", "bob", "carol");
  const alice = await account(stack, aliceName);
  const bob = await account(stack, bobName);
  const carol = await account(stack, carolName);
  const personal = await personalKeyOf(alice);
  const team = `team-${aliceName}`;
  using _space = await alice.createSpace(team, "Crew");

  // Bob builds on the workspace and Carol uses it, by grants of their own: the two kinds of
  // session a collaborator subscribes from.
  const { workspace, id } = await activeWorkspace(stack, aliceName);
  await listedIn(workspace, personal);
  await workspace.addCollaborator(bobName, "build");
  await workspace.addCollaborator(carolName, "use");
  using asBob = await bob.openGadget(id);
  using asCarol = await carol.openGadget(id);
  const seenBy = { bob: [] as GadgetMetadata[], carol: [] as GadgetMetadata[] };
  using _bobSubscription = await asBob.subscribeToMetadata(metadata => {
    seenBy.bob.push(metadata);
  });
  using _carolSubscription = await asCarol.subscribeToMetadata(metadata => {
    seenBy.carol.push(metadata);
  });

  /** Polls, for a bounded time, until each subscription's latest update names space `key`. */
  const toldOf = (key: string) => Promise.all(Object.entries(seenBy).map(([who, seen]) =>
    waitFor(`${who}'s subscription to name space ${key}`, async () =>
      seen.at(-1)?.listedIn === key ? seen.at(-1)! : null)));

  // Each is told the personal space at once, then the team space it is moved to, and the
  // personal space again once it is moved back, with no session ended on the way.
  const [bobFirst, carolFirst] = await toldOf(personal);
  expect(bobFirst).toMatchObject({ role: "build" });
  expect(carolFirst).toMatchObject({ role: "use" });
  await workspace.moveToSpace(team);
  await toldOf(team);
  await workspace.moveToSpace(null);
  await toldOf(personal);
  expect(await asBob.getMetadata()).toMatchObject({ role: "build", listedIn: personal });
  expect(await asCarol.getMetadata()).toMatchObject({ role: "use", listedIn: personal });
});
