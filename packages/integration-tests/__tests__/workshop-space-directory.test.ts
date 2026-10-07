// The space directory end to end over the real RPC API: which spaces anyone signed in finds with
// `listPublishedSpaces`, and that opening one is still decided by the space. A space is listed
// while a published workspace sits at the top of its tree; a published workspace under an
// unpublished one lists nothing, and unpublishing the last published one at the top takes the
// space out again.
//
// Alice owns every workspace; Bob is in no space of hers, so he finds and sees her spaces only as
// a visitor. Each space pushes to the directory from its alarm, apart from the call that lists
// or unlists it, so a space's appearance and disappearance are polled for, for a bounded time,
// and its staying absent is read only once a sentinel space, listed after the change, has
// appeared: a push the change would have queued has had longer to land than the sentinel's.
// Every workspace is held on a session of its own, as in workshop-publication-cascade.test.ts,
// so that a restart of one ends no other stub. The directory is deployment-wide, so a search
// carries a fresh username, and a space's absence is asserted of its key, not of the whole page:
// "alice1" also matches the spaces of "alice12".

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuthenticatedApi, PublishedSpaceInfo, Space } from "@gadgets/workshop-shared/api";
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

/** A new account `username`, shown as `displayName`, on a session of its own that `stack` owns. */
async function account(stack: DisposableStack, username: string, displayName = username)
    : Promise<RpcStub<AuthenticatedApi>> {
  return stack.use(await signUp(stack.use(connect(requireHarness().url)), username, displayName));
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
 * thing to count as, and polled for, for a bounded time.
 */
async function listedWorkspace(
    stack: DisposableStack, ownerName: string, key: string | undefined, space: RpcStub<Space>,
    title: string, parentId?: string) {
  const workspace = stack.use(await (await session(stack, ownerName)).newGadget(key, parentId));
  const { id } = await workspace.getMetadata();
  await workspace.setTitle(title);
  await workspace.newChat("Seen activity, with no agent", null);
  await waitFor(`workspace "${title}" in the space's listing`, async () =>
    (await space.listWorkspaces()).some(listed => listed.id === id && listed.title === title)
        || null);
  return { workspace, id };
}

/** Every space the directory lists for `query`, across all its pages, as `api`'s caller. */
async function directory(api: RpcStub<AuthenticatedApi>, query: string)
    : Promise<PublishedSpaceInfo[]> {
  const spaces: PublishedSpaceInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listPublishedSpaces(query, cursor);
    spaces.push(...page.spaces);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return spaces;
}

/** The keys of the spaces the directory lists for `query`, as `api`'s caller. */
const listedKeys = async (api: RpcStub<AuthenticatedApi>, query: string) =>
  (await directory(api, query)).map(({ key }) => key);

/** Polls, for a bounded time, until the directory lists space `key` for `query`. */
const appears = (api: RpcStub<AuthenticatedApi>, query: string, key: string) =>
  waitFor(`space ${key} in the directory for "${query}"`, async () =>
    (await directory(api, query)).find(space => space.key === key) ?? null);

/** Polls, for a bounded time, until the directory no longer lists space `key` for `query`. */
const disappears = (api: RpcStub<AuthenticatedApi>, query: string, key: string) =>
  waitFor(`space ${key} to leave the directory for "${query}"`, async () =>
    (await listedKeys(api, query)).includes(key) ? null : true);

/**
 * Lists a new team space of `owner`'s, whose username is `ownerName`, and waits, for a bounded
 * time, until `viewer` finds it in the directory by that username: by then a push queued before
 * this has had longer to land, so a space's absence read afterwards means it was not pushed as
 * listed.
 */
async function sentinelListed(
    stack: DisposableStack, owner: RpcStub<AuthenticatedApi>, ownerName: string,
    viewer: RpcStub<AuthenticatedApi>) {
  const key = `sentinel-${ownerName}`;
  using space = await owner.createSpace(key, `Sentinel ${ownerName}`);
  const { workspace } = await listedWorkspace(stack, ownerName, key, space, "Sentinel");
  await workspace.setPublicAccess("use");
  await appears(viewer, ownerName, key);
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

it.concurrent("a team space is listed while a published workspace sits at the top of its tree, "
    + "and is found by part of its name", async () => {
  using stack = new DisposableStack();
  const [aliceName, bobName] = nextUsernames("alice", "bob");
  const alice = await account(stack, aliceName);
  const bob = await account(stack, bobName);
  // Unique for the harness's lifetime, as the usernames are. The dash is part of the key grammar.
  const key = `harbour-${aliceName}`;
  using space = await alice.createSpace(key, `Harbour Crew ${aliceName}`);

  //   Handbook ── Holidays
  const parent = await listedWorkspace(stack, aliceName, key, space, "Handbook");
  const child = await listedWorkspace(stack, aliceName, key, space, "Holidays", parent.id);

  // Holidays published under the unpublished Handbook: nothing published sits at the top of the
  // tree, so the space is in no one's directory, its owner's included, and refuses Bob.
  await child.workspace.setPublicAccess("use");
  await sentinelListed(stack, alice, aliceName, bob);
  expect(await listedKeys(bob, aliceName)).not.toContain(key);
  expect(await listedKeys(alice, aliceName)).not.toContain(key);
  await expect(refusal(bob.openSpace(key))).resolves.toMatch(/no such space/i);

  // Handbook published, the space appears, for Bob and for Alice alike, as a team space with no
  // owner, and is found by a fragment of its name in any case, but not by an unrelated one.
  await parent.workspace.setPublicAccess("use");
  expect(await appears(bob, aliceName, key))
      .toEqual({ key, name: `Harbour Crew ${aliceName}`, kind: "team" });
  await appears(alice, aliceName, key);
  await appears(bob, `BOUR CREW ${aliceName.toUpperCase()}`, key);
  expect(await listedKeys(bob, `harbour crew ${bobName}`)).not.toContain(key);

  // Bob, opening it as a visitor, is shown both published workspaces.
  using visiting = await bob.openSpace(key);
  expect((await visiting.listWorkspaces()).map(({ id }) => id)).toEqual([parent.id, child.id]);

  // Handbook unpublished again, the space leaves the directory although Holidays is still
  // published, and refuses Bob once more.
  await parent.workspace.setPublicAccess(null);
  await disappears(bob, aliceName, key);
  expect(await listedKeys(alice, aliceName)).not.toContain(key);
  await expect(refusal(bob.openSpace(key))).resolves.toMatch(/no such space/i);
});

it.concurrent("a personal space is listed while it has a published workspace at the top, found "
    + "by its name, and shows a visitor only its visible workspaces", async () => {
  using stack = new DisposableStack();
  const [aliceName, bobName] = nextUsernames("alice", "bob");
  const ownerName = `Quill Keeper ${aliceName}`;
  const alice = await account(stack, aliceName, ownerName);
  const bob = await account(stack, bobName);
  const [personal] = await alice.listSpaces();
  if (personal?.kind !== "personal") throw new Error("Alice's listing led with no personal space");
  const { key } = personal;
  using space = await alice.openSpace(key);

  //   Notice Board
  //   Drafts ── Holidays
  const notice = await listedWorkspace(stack, aliceName, undefined, space, "Notice Board");
  const drafts = await listedWorkspace(stack, aliceName, undefined, space, "Drafts");
  const child = await listedWorkspace(stack, aliceName, undefined, space, "Holidays", drafts.id);

  // With only a workspace under an unpublished one published, it is not listed.
  await child.workspace.setPublicAccess("use");
  await sentinelListed(stack, alice, aliceName, bob);
  expect(await listedKeys(bob, aliceName)).not.toContain(key);

  // The Notice Board published, the space appears, found by part of its name, which is its
  // owner's display name, with the owner shown.
  await notice.workspace.setPublicAccess("use");
  const owner = await alice.whoami();
  expect(await appears(bob, `keeper ${aliceName}`, key)).toEqual({
    key, name: ownerName, kind: "personal", owner: { type: "user", id: owner.id, name: ownerName },
  });

  // Listed, the space still decides what Bob sees: the Notice Board alone, since Holidays sits
  // under the unpublished Drafts.
  using visiting = await bob.openSpace(key);
  expect((await visiting.listWorkspaces()).map(({ id }) => id)).toEqual([notice.id]);

  // The Notice Board unpublished, the last published workspace at the top is gone, and so is
  // the space from the directory.
  await notice.workspace.setPublicAccess(null);
  await disappears(bob, aliceName, key);
});
