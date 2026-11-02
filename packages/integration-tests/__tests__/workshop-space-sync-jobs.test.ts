// Space-sync jobs end to end over the real RPC API: a user starts a sync into a space through a
// connected account that declares `providesSpaceSync`, the account reports progress through the
// job-scoped target the Workshop handed it, and the job record the user's account keeps is the
// one authority on what that target may still do.
//
// The fixture gatekeeper's account stands in for a connector. Its startSpaceSync() keeps the
// target in its own storage and reports a first "running" progress before it resolves; every
// later report is one the test makes through that stored target (`/control/space-sync-report`),
// so a refusal and its code come back as data.
//
// A job record is written before the call that changed it returns, so the tests read the
// listing back directly, with no polling.

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuthenticatedApi, SpaceSyncJobInfo } from "@gadgets/workshop-shared/api";
import { SPACE_SYNC_ERROR_CODES, type SpaceSyncProgress } from "@gadgets/workshop-shared/gatekeeper";
import {
  type Harness, startTestGatekeeperHarness, TEST_VENDOR_ID, testControl,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, connect, listConnectedAccounts, nextUsernames, signUp, waitFor,
  type ConnectedAccount,
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
  const account = await waitFor("the fixture account to be provisioned", async () =>
    (await listConnectedAccounts(api)).find(({ vendorId }) => vendorId === TEST_VENDOR_ID) ?? null);
  expect(account.description.providesSpaceSync).toEqual(
      { blueprintId: "format.document", importMethods: [] });
  return account;
}

/** The key of the caller's personal space, the first entry of their listing. */
async function personalSpaceKey(api: RpcStub<AuthenticatedApi>): Promise<string> {
  const [personal] = await api.listSpaces();
  if (personal?.kind !== "personal") throw new Error("The listing held no personal space");
  return personal.key;
}

/** A resource the fixture account binds, distinct per test. */
const syncResource = (name: string) => `https://gadgets-test.example/things/sync-${name}`;

type ReportReply = { reported: true } | { error: string; code: string | null };

/** Report `progress` for job `jobId` through the target the fixture's startSpaceSync() stored. */
const report = (jobId: string, progress: SpaceSyncProgress) =>
  testControl<ReportReply>(requireHarness(), "space-sync-report", { jobId, progress });

type SyncState =
  | { started: false }
  | { started: true; label: string; resourceUrl: string; cancelCount: number };

/** What the fixture knows of job `jobId`: whether it was started, and how often cancelled. */
const syncState = (jobId: string) =>
  testControl<SyncState>(requireHarness(), "space-sync-state", { jobId });

/** Job `jobId` as the caller's listing shows it. */
async function listedJob(api: RpcStub<AuthenticatedApi>, jobId: string)
    : Promise<SpaceSyncJobInfo> {
  const job = (await api.listSpaceSyncJobs()).find(listed => listed.jobId === jobId);
  if (job === undefined) throw new Error(`Job ${jobId} is not in its user's listing`);
  return job;
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

it.concurrent("a sync into the caller's personal space runs, reports progress and finishes",
    async () => {
  const [aliceName] = usernames("syncer");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  const account = await provisionedAccount(alice);
  const spaceKey = await personalSpaceKey(alice);
  const resourceUrl = syncResource(aliceName);

  // The account reported before startSpaceSync() resolved, so the job returned shows it. The
  // fixture's blueprint declares no publication, so the Workshop chose "use".
  const started = await alice.startSpaceSync(account.id, spaceKey, { resourceUrl });
  expect(started).toMatchObject({
    accountId: account.id,
    vendorId: TEST_VENDOR_ID,
    spaceKey,
    publication: "use",
    status: "running",
    progress: { done: 0, total: 2, warnings: [] },
  });
  expect(started.created).toBeInstanceOf(Date);
  expect(started).not.toHaveProperty("parentId");
  expect(started).not.toHaveProperty("finished");
  expect(started).not.toHaveProperty("error");
  const { jobId } = started;
  expect(await syncState(jobId)).toEqual(
      { started: true, label: accountLabel(account), resourceUrl, cancelCount: 0 });

  expect(await alice.listSpaceSyncJobs(spaceKey)).toEqual([started]);
  expect(await alice.listSpaceSyncJobs()).toEqual([started]);
  expect(await alice.listSpaceSyncJobs(`team-${aliceName}`)).toEqual([]);

  // One running job per user per space.
  expect(await refusal(alice.startSpaceSync(account.id, spaceKey, { resourceUrl })))
      .toMatch(/already running/i);

  const warning = "Item b: skipped an embedded chart";
  expect(await report(jobId, { state: "running", done: 1, total: 2, warnings: [warning] }))
      .toEqual({ reported: true });
  expect(await listedJob(alice, jobId)).toMatchObject(
      { status: "running", progress: { done: 1, total: 2, warnings: [warning] } });

  // Each report replaces the last whole, warnings included.
  expect(await report(jobId, { state: "done", done: 2, total: 2 })).toEqual({ reported: true });
  const done = await listedJob(alice, jobId);
  expect(done).toMatchObject({
    status: "done", publication: "use", progress: { done: 2, total: 2, warnings: [] },
  });
  expect(done.finished).toBeInstanceOf(Date);
  expect(done).not.toHaveProperty("error");

  // The target acts for a running job only.
  expect(await report(jobId, { state: "running", done: 2 }))
      .toMatchObject({ code: SPACE_SYNC_ERROR_CODES.finished });
  expect((await listedJob(alice, jobId)).progress).toEqual(done.progress);

  // With none running, a new sync into the space may start, and lists first.
  const next = await alice.startSpaceSync(account.id, spaceKey, { resourceUrl });
  expect(next.status).toBe("running");
  expect((await alice.listSpaceSyncJobs(spaceKey)).map(job => job.jobId))
      .toEqual([next.jobId, jobId]);
});

it.concurrent("a sync is refused into a space the caller may not add to, recording nothing",
    async () => {
  const [aliceName, bobName] = usernames("spaceowner", "intruder");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  const bob = await newAccount(stack, bobName);
  const bobAccount = await provisionedAccount(bob);
  const aliceKey = await personalSpaceKey(alice);

  expect(await refusal(bob.startSpaceSync(
      bobAccount.id, aliceKey, { resourceUrl: syncResource(bobName) })))
      .toMatch(/not a member/i);
  expect(await bob.listSpaceSyncJobs()).toEqual([]);
  expect(await alice.listSpaceSyncJobs()).toEqual([]);

  // Into a space of their own, a parent the space does not list is refused too.
  const bobKey = await personalSpaceKey(bob);
  expect(await refusal(bob.startSpaceSync(bobAccount.id, bobKey,
      { resourceUrl: syncResource(bobName), parentId: "not-a-listed-workspace" })))
      .toMatch(/does not list/i);
  expect(await bob.listSpaceSyncJobs()).toEqual([]);
});

it.concurrent("cancelling a running sync ends it and refuses the account's later reports",
    async () => {
  const [aliceName] = usernames("canceller");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  const account = await provisionedAccount(alice);
  const spaceKey = await personalSpaceKey(alice);
  const { jobId } = await alice.startSpaceSync(
      account.id, spaceKey, { resourceUrl: syncResource(aliceName) });

  await alice.cancelSpaceSync(jobId);
  const cancelled = await listedJob(alice, jobId);
  expect(cancelled).toMatchObject({ status: "cancelled", progress: { done: 0, total: 2 } });
  expect(cancelled.finished).toBeInstanceOf(Date);
  expect(await syncState(jobId)).toMatchObject({
    started: true, cancelCount: 1, cancelReport: SPACE_SYNC_ERROR_CODES.cancelled,
  });

  expect(await report(jobId, { state: "running", done: 1, total: 2 }))
      .toMatchObject({ code: SPACE_SYNC_ERROR_CODES.cancelled });
  expect(await report(jobId, { state: "done", done: 2, total: 2 }))
      .toMatchObject({ code: SPACE_SYNC_ERROR_CODES.cancelled });
  expect(await listedJob(alice, jobId)).toEqual(cancelled);

  // Cancelling an ended job does nothing, and the account is not asked again; a job the caller
  // has none of is refused.
  await alice.cancelSpaceSync(jobId);
  expect(await listedJob(alice, jobId)).toEqual(cancelled);
  expect(await syncState(jobId)).toMatchObject({ cancelCount: 1 });
  expect(await refusal(alice.cancelSpaceSync(crypto.randomUUID()))).toMatch(/no such/i);
});

it.concurrent("disconnecting the account cancels its running sync", async () => {
  const [aliceName] = usernames("disconnector");
  using stack = new DisposableStack();
  const alice = await newAccount(stack, aliceName);
  const account = await provisionedAccount(alice);
  const spaceKey = await personalSpaceKey(alice);
  const { jobId } = await alice.startSpaceSync(
      account.id, spaceKey, { resourceUrl: syncResource(aliceName) });

  await alice.disconnectAccount(account.id);
  expect((await listConnectedAccounts(alice)).map(({ id }) => id)).not.toContain(account.id);
  const cancelled = await listedJob(alice, jobId);
  expect(cancelled).toMatchObject({ status: "cancelled", vendorId: TEST_VENDOR_ID });
  expect(cancelled.finished).toBeInstanceOf(Date);
  expect(await syncState(jobId)).toMatchObject({
    started: true, cancelCount: 1, cancelReport: SPACE_SYNC_ERROR_CODES.cancelled,
  });
  expect(await testControl(requireHarness(), "revocation-count", { label: accountLabel(account) }))
      .toEqual({ count: 1 });

  expect(await report(jobId, { state: "running", done: 1, total: 2 }))
      .toMatchObject({ code: SPACE_SYNC_ERROR_CODES.cancelled });
  expect(await listedJob(alice, jobId)).toEqual(cancelled);
});
