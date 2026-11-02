// What a space-sync job writes, end to end over the real RPC API: the workspaces the account asks
// for through its job-scoped target (`ensureWorkspace`), how it retitles them and calls their
// gadget (`setWorkspaceTitle`, `writeWorkspace`), how ending the job revokes all of that, and how
// the owner re-syncs one synced workspace from its source item (`resyncWorkspace`).
//
// The fixture gatekeeper's account stands in for a connector. Its startSpaceSync() keeps the
// target in its own storage; every call here is one the test makes through that stored target
// (`/control/space-sync-ensure`, `-ensure-twice`, `-title`, `-write`), so a refusal and its code
// come back as data.
// The account declares no import methods, and no bundled blueprint lists any, so a write is only
// ever seen refused.
//
// `ensureWorkspace` resolves once the space lists the workspace, and a retitle once the listing
// follows it, so the tests read the listings back directly, with no polling.

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuthenticatedApi, SpaceWorkspaceInfo } from "@gadgets/workshop-shared/api";
import { SPACE_SYNC_ERROR_CODES } from "@gadgets/workshop-shared/gatekeeper";
import {
  type Harness, startTestGatekeeperHarness, TEST_VENDOR_ID, testControl,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, MAX_OBSERVER_PROMPTS, nextUsernames, ObserverConfigRecorder,
  signUp, stubFor, waitFor, type ConnectedAccount,
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

/** Sign a new account up on a session of its own; `stack` owns both. */
async function newAccount(stack: DisposableStack, username: string)
    : Promise<RpcStub<AuthenticatedApi>> {
  const publicApi = stack.use(connect(requireHarness().url));
  return stack.use(await signUp(publicApi, username));
}

/** Provision the caller a fixture account, which declares `providesSpaceSync`. */
async function provisionedAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the fixture account to be provisioned", async () =>
    (await listConnectedAccounts(api)).find(({ vendorId }) => vendorId === TEST_VENDOR_ID) ?? null);
}

/** The key of the caller's personal space, the first entry of their listing. */
async function personalSpaceKey(api: RpcStub<AuthenticatedApi>): Promise<string> {
  const [personal] = await api.listSpaces();
  if (personal?.kind !== "personal") throw new Error("The listing held no personal space");
  return personal.key;
}

/**
 * A source item's address, distinct per test. Under the fixture's resource pattern, since a
 * re-sync passes it through the admin chokepoint as a resource URL.
 */
const sourceUrl = (name: string, item: string) =>
  `https://gadgets-test.example/things/sync-${name}/${item}`;

type Refused = { error: string; code: string | null };

/** Ask, through job `jobId`'s stored target, for the workspace of a source item. */
const ensure = (jobId: string, item: { sourceUrl: string; title: string; parentId?: string }) =>
  testControl<{ workspaceId: string } | Refused>(
      requireHarness(), "space-sync-ensure", { jobId, ...item });

/**
 * Ask twice for the workspace of one source item, the fixture making the second call before the
 * first is answered, so that both are under way in the Workshop at once: two requests from here
 * would reach it one after the other.
 */
const ensureTwice = (jobId: string, item: { sourceUrl: string; title: string }) =>
  testControl<({ workspaceId: string } | Refused)[]>(
      requireHarness(), "space-sync-ensure-twice", { jobId, ...item });

/** Retitle workspace `workspaceId` through job `jobId`'s stored target. */
const retitle = (jobId: string, workspaceId: string, title: string) =>
  testControl<{ retitled: true } | Refused>(
      requireHarness(), "space-sync-title", { jobId, workspaceId, title });

/** Call `method` on workspace `workspaceId`'s gadget through job `jobId`'s stored target. */
const write = (jobId: string, workspaceId: string, method: string, args: unknown) =>
  testControl<{ written: true } | Refused>(
      requireHarness(), "space-sync-write", { jobId, workspaceId, method, args });

/** The id of the workspace `ensure` gave, failing on a refusal. */
async function ensured(jobId: string,
    item: { sourceUrl: string; title: string; parentId?: string }): Promise<string> {
  const reply = await ensure(jobId, item);
  if (!("workspaceId" in reply)) throw new Error(`ensureWorkspace was refused: ${reply.error}`);
  return reply.workspaceId;
}

type SyncState =
  | { started: false }
  | { started: true; label: string; resourceUrl: string; scope?: string; cancelCount: number };

/** What the fixture knows of job `jobId`: whether it was started, with what, and how often cancelled. */
const syncState = (jobId: string) =>
  testControl<SyncState>(requireHarness(), "space-sync-state", { jobId });

/** Workspace `id` as the caller's own `listGadgets` shows it. */
async function ownRecord(api: RpcStub<AuthenticatedApi>, id: string) {
  const record = (await api.listGadgets()).find(gadget => gadget.id === id);
  if (record === undefined) throw new Error(`Workspace ${id} is not in its owner's listing`);
  return record;
}

/**
 * The id of a new workspace of `api`'s own, in their personal space, titled `title`, once it has
 * seen activity, which a chat that starts no agent is the cheapest thing to count as, and so
 * shows in `listGadgets`. `stack` owns the session on it.
 */
async function activeWorkspace(stack: DisposableStack, api: RpcStub<AuthenticatedApi>,
    title: string): Promise<string> {
  const workspace = stack.use(await api.newGadget());
  const { id } = await workspace.getMetadata();
  await workspace.setTitle(title);
  await workspace.newChat("Seen activity, with no agent", null);
  await waitFor(`workspace "${title}" in its owner's listing`, async () =>
    (await api.listGadgets()).find(gadget => gadget.id === id) ?? null);
  return id;
}

/** Space `key`'s listing, as `api` opens it. */
async function spaceListing(api: RpcStub<AuthenticatedApi>, key: string)
    : Promise<SpaceWorkspaceInfo[]> {
  using space = await api.openSpace(key);
  return space.listWorkspaces();
}

/** The message `call` is refused with. Fails if it succeeds. */
async function refusal(call: PromiseLike<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the call to be refused");
}

it.concurrent("a sync into the personal space creates, retitles and refuses to write its "
    + "workspaces, and cancelling it refuses every later call", async () => {
  const [aliceName] = usernames("syncwriter");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  const account = await provisionedAccount(alice);
  const spaceKey = await personalSpaceKey(alice);
  const handbookUrl = sourceUrl(aliceName, "handbook");
  const { jobId, publication } = await alice.startSpaceSync(
      account.id, spaceKey, { resourceUrl: sourceUrl(aliceName, "root") });
  expect(publication).toBe("use");
  expect(await syncState(jobId)).not.toHaveProperty("scope");

  // Concurrent asks for one item create one workspace.
  const [first, concurrent] = await ensureTwice(jobId, { sourceUrl: handbookUrl, title: "Handbook" });
  expect(first).toHaveProperty("workspaceId");
  expect(concurrent).toEqual(first);
  const id = (first as { workspaceId: string }).workspaceId;

  // Listed, titled, addressed and published at the job's role by the time the call returned.
  expect(await ownRecord(alice, id)).toMatchObject({
    title: "Handbook", publicAccess: publication, syncedFrom: { accountId: account.id },
  });
  expect(await ownRecord(alice, id)).not.toHaveProperty("owner");
  expect(await ownRecord(alice, id)).not.toHaveProperty("spaceKey");
  const listed = (await spaceListing(alice, spaceKey)).filter(entry => entry.id === id);
  expect(listed).toEqual([expect.objectContaining(
      { title: "Handbook", slug: "handbook", published: publication })]);
  expect(listed[0]).not.toHaveProperty("parentId");
  expect(listed[0]).not.toHaveProperty("hiddenBy");

  // A retry after a lost reply returns the same workspace, keeping its title.
  expect(await ensure(jobId, { sourceUrl: handbookUrl, title: "Ignored" }))
      .toEqual({ workspaceId: id });
  expect((await ownRecord(alice, id)).title).toBe("Handbook");

  // An item asked for under one the space lists goes under it.
  const childId = await ensured(jobId,
      { sourceUrl: sourceUrl(aliceName, "onboarding"), title: "Onboarding", parentId: id });
  expect(childId).not.toBe(id);
  expect((await spaceListing(alice, spaceKey)).find(entry => entry.id === childId))
      .toMatchObject({ title: "Onboarding", parentId: id, published: publication });

  // A retitle reaches the record and the listing; the slug stays where it was.
  expect(await retitle(jobId, id, "Handbook (2026)")).toEqual({ retitled: true });
  expect((await ownRecord(alice, id)).title).toBe("Handbook (2026)");
  expect((await spaceListing(alice, spaceKey)).find(entry => entry.id === id))
      .toMatchObject({ title: "Handbook (2026)", slug: "handbook" });

  // No method is declared by both the account and the blueprint, so every write is refused.
  expect(await write(jobId, id, "importContent", { body: "From the source" }))
      .toMatchObject({ code: SPACE_SYNC_ERROR_CODES.notAllowed });

  // A workspace of Alice's in the job's space that no sync created is not the job's to touch.
  const ownId = await activeWorkspace(stack, alice, "Notes");
  expect(await retitle(jobId, ownId, "Taken over"))
      .toMatchObject({ code: SPACE_SYNC_ERROR_CODES.workspaceGone });
  expect(await write(jobId, ownId, "importContent", {}))
      .toMatchObject({ code: SPACE_SYNC_ERROR_CODES.workspaceGone });
  expect((await ownRecord(alice, ownId)).title).toBe("Notes");

  // Once the job is cancelled, the target does nothing more.
  await alice.cancelSpaceSync(jobId);
  expect(await ensure(jobId, { sourceUrl: handbookUrl, title: "Handbook" }))
      .toMatchObject({ code: SPACE_SYNC_ERROR_CODES.cancelled });
  expect(await ensure(jobId, { sourceUrl: sourceUrl(aliceName, "late"), title: "Late" }))
      .toMatchObject({ code: SPACE_SYNC_ERROR_CODES.cancelled });
  expect(await retitle(jobId, id, "After the end"))
      .toMatchObject({ code: SPACE_SYNC_ERROR_CODES.cancelled });
  expect(await write(jobId, id, "importContent", {}))
      .toMatchObject({ code: SPACE_SYNC_ERROR_CODES.cancelled });
  expect((await ownRecord(alice, id)).title).toBe("Handbook (2026)");
  expect((await spaceListing(alice, spaceKey)).map(entry => entry.title)).not.toContain("Late");
});

it.concurrent("the owner re-syncs a synced workspace from its source item, and no one else can",
    async () => {
  const [aliceName, bobName] = usernames("resyncer", "bystander");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  const bob = await newAccount(stack, bobName);
  const account = await provisionedAccount(alice);
  const spaceKey = await personalSpaceKey(alice);
  const itemUrl = sourceUrl(aliceName, "guide");
  const sync = await alice.startSpaceSync(
      account.id, spaceKey, { resourceUrl: sourceUrl(aliceName, "root") });
  const id = await ensured(sync.jobId, { sourceUrl: itemUrl, title: "Guide" });

  // A workspace no sync created has nothing to re-sync from.
  const ownId = await activeWorkspace(stack, alice, "Notes");
  expect(await refusal(alice.resyncWorkspace(ownId))).toMatch(/not created by a space sync/i);

  // One job runs into a space at a time, a re-sync included.
  expect(await refusal(alice.resyncWorkspace(id))).toMatch(/already running/i);
  await alice.cancelSpaceSync(sync.jobId);

  const resync = await alice.resyncWorkspace(id);
  expect(resync).toMatchObject({
    accountId: account.id, vendorId: TEST_VENDOR_ID, spaceKey, publication: "use",
    status: "running",
  });
  expect(resync.jobId).not.toBe(sync.jobId);
  expect(await syncState(resync.jobId)).toMatchObject(
      { started: true, resourceUrl: itemUrl, scope: "item", cancelCount: 0 });
  expect(await alice.listSpaceSyncJobs(spaceKey))
      .toEqual([resync, expect.objectContaining({ jobId: sync.jobId, status: "cancelled" })]);

  // The item job finds the workspace the item was synced into.
  expect(await ensure(resync.jobId, { sourceUrl: itemUrl, title: "Guide again" }))
      .toEqual({ workspaceId: id });
  expect((await spaceListing(alice, spaceKey)).filter(entry => entry.title.startsWith("Guide")))
      .toEqual([expect.objectContaining({ id, title: "Guide" })]);

  // Someone else's synced workspace is not theirs to re-sync, and nothing is started for them,
  // even once it has been shared with them and they hold a record of it.
  expect(await refusal(bob.resyncWorkspace(id))).toMatch(/no such workspace/i);
  {
    using workspace = await alice.openGadget(id);
    expect(await workspace.addCollaborator(bobName, "build")).toBeTruthy();
  }
  // Alice's fixture account is ambient in the workspace, so Bob answers for his own on opening it.
  const bobAccount = await provisionedAccount(bob);
  using observers = stubFor(
      new ObserverConfigRecorder().alwaysChoose(bobAccount.id, MAX_OBSERVER_PROMPTS));
  (await bob.openGadget(id, undefined, observers))[Symbol.dispose]();
  expect(await ownRecord(bob, id)).toMatchObject({ owner: { id: aliceName } });
  expect(await ownRecord(bob, id)).not.toHaveProperty("syncedFrom");
  expect(await refusal(bob.resyncWorkspace(id))).toMatch(/no such workspace/i);
  expect(await bob.listSpaceSyncJobs()).toEqual([]);
  expect((await alice.listSpaceSyncJobs()).map(job => job.jobId))
      .toEqual([resync.jobId, sync.jobId]);
});
