// Where a workspace created from a blueprint lands, end to end over the real RPC API: the space
// and the parent `newGadgetFromBlueprint` is given, under the blueprint's title, and published
// only when the blueprint declares a default publication, which none of the blueprints this
// harness installs does.
//
// The blueprint is the deployment's bundled document format, installed on the first `/api`
// request. Creating a workspace from it is its first activity, so each test polls, for a bounded
// time, until the space lists it, since that listing follows a sync its owner's account runs
// apart from the call. The default publication itself, and opting out of it, are left to the
// backend's unit tests: the bundled set is compiled into the Workshop when it is built, and none
// of the blueprints in it declares one.

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuthenticatedApi, Space } from "@gadgets/workshop-shared/api";
import { type Harness, startTestGatekeeperHarness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, waitFor } from "../src/rpc-client.js";

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
 * Alice and Dave, each signed up on a session of their own, a team space of Alice's that Dave is
 * not in, and the bundled document blueprint as the deployment publishes it.
 */
async function setUp(stack: DisposableStack) {
  const [aliceName, daveName] = nextUsernames("alice", "dave");
  const publicApi = stack.use(connect(requireHarness().url));
  const alice = stack.use(await signUp(publicApi, aliceName));
  const dave = stack.use(await signUp(stack.use(connect(requireHarness().url)), daveName));
  const key = `team-${aliceName}`;
  const space = stack.use(await alice.createSpace(key, "Crew"));
  const formats = await waitFor("bundled output formats to install", async () => {
    const offers = await alice.listOutputFormats();
    return offers.length > 0 ? offers : null;
  });
  const offer = formats.find(format => format.output.id === "document");
  if (offer === undefined) throw new Error("Document output format is not installed");
  const blueprint = await publicApi.getBlueprint(offer.blueprintId);
  if (blueprint === null) throw new Error("Document blueprint is not installed");
  return { alice, dave, daveName, key, space, blueprint };
}

/**
 * Workspace `id` as `space` lists it, once it does, under `title`: polled for, for a bounded
 * time.
 */
const listedAs = (space: RpcStub<Space>, id: string, title: string) =>
  waitFor(`workspace "${title}" in the space's listing`, async () => {
    const entry = (await space.listWorkspaces()).find(workspace => workspace.id === id);
    return entry?.title === title ? entry : null;
  });

/** Workspace `id` as its owner's list of workspaces gives it. */
async function ownRecord(api: RpcStub<AuthenticatedApi>, id: string) {
  const record = (await api.listGadgets()).find(gadget => gadget.id === id);
  if (record === undefined) throw new Error(`Workspace ${id} is not in its owner's list`);
  return record;
}

/**
 * What Dave is refused with when he opens a team space nobody has claimed, which is also what a
 * space with nothing published to him refuses him with.
 */
const unclaimedRefusal = (dave: RpcStub<AuthenticatedApi>, daveName: string) =>
  refusal(dave.openSpace(`free-${daveName}`));

it.concurrent("places a workspace in the team space a string third argument names, under the "
    + "blueprint's title, unpublished", async () => {
  using stack = new DisposableStack();
  const { alice, dave, daveName, key, space, blueprint } = await setUp(stack);
  // The bundled blueprints of this deployment declare no default publication.
  expect(blueprint.metadata).not.toHaveProperty("publication");

  const workspace = stack.use(await alice.newGadgetFromBlueprint(blueprint.id, {}, key));
  const metadata = await workspace.getMetadata();
  expect(metadata.title).toBe(blueprint.metadata.title);
  expect(metadata.publicAccess).toBeUndefined();
  const record = await ownRecord(alice, metadata.id);
  expect(record.spaceKey).toBe(key);
  expect(record.publicAccess).toBeUndefined();

  const entry = await listedAs(space, metadata.id, blueprint.metadata.title);
  expect(entry).not.toHaveProperty("parentId");
  expect(entry).not.toHaveProperty("published");
  // Nothing in the space is published, so Dave is refused it as a key nobody claimed.
  expect(await refusal(dave.openSpace(key))).toBe(await unclaimedRefusal(dave, daveName));
});

it.concurrent("places a workspace in the space and under the parent the options name, and does "
    + "not publish it from a blueprint that declares no publication", async () => {
  using stack = new DisposableStack();
  const { alice, key, space, blueprint } = await setUp(stack);
  const { title } = blueprint.metadata;

  const parent =
      stack.use(await alice.newGadgetFromBlueprint(blueprint.id, {}, { spaceKey: key }));
  const { id: parentId } = await parent.getMetadata();
  expect(await listedAs(space, parentId, title)).not.toHaveProperty("parentId");

  const child = stack.use(
      await alice.newGadgetFromBlueprint(blueprint.id, {}, { spaceKey: key, parentId }));
  const { id: childId } = await child.getMetadata();
  const entry = await listedAs(space, childId, title);
  expect(entry).toMatchObject({ parentId, position: 0 });
  expect(entry).not.toHaveProperty("published");

  // Asking for the blueprint's default publication publishes nothing when it declares none.
  const asked = stack.use(await alice.newGadgetFromBlueprint(
      blueprint.id, {}, { spaceKey: key, parentId, publish: true }));
  const askedMetadata = await asked.getMetadata();
  expect(askedMetadata.publicAccess).toBeUndefined();
  const askedEntry = await listedAs(space, askedMetadata.id, title);
  expect(askedEntry).toMatchObject({ parentId, position: 1 });
  expect(askedEntry).not.toHaveProperty("published");
  expect((await ownRecord(alice, askedMetadata.id)).publicAccess).toBeUndefined();
});
