// Regression tests for observer re-verification on re-open.
//
// A collaborator's observer account choice is persisted after their first successful open, so on every
// later open ensureObserver() re-verifies without prompting. When that verification fails -- routinely,
// because credentials lapse -- the open used to dead-end with "You are not permitted to observe all of
// the data this Gadget has accessed" and no way forward. It should instead re-prompt through
// ObserverConfigCallback with the failure attached, and if the re-prompt doesn't fix it, say which
// connection and which account failed.
//
// Nothing is stubbed but the network. The real workshop-backend runs under wrangler, tests speak Cap'n
// Web over a WebSocket to /api exactly as the browser does, and the gatekeeper is a real Worker
// speaking the real protocol -- one whose verification outcome the tests set, which is the whole reason
// the fixture exists (see fixtures/gatekeeper-test/src/test-gatekeeper.ts).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, Overseer, PublicApi } from "@gadgets/workshop-shared/api";
import {
  startTestGatekeeperHarness, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import {
  accountLabel, connect, listConnectedAccounts, MAX_OBSERVER_PROMPTS, nextUsernames,
  ObserverConfigRecorder, signUp, stubFor, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

// Reason text shaped like the two failures a gatekeeper actually reports. The overseer cannot tell
// them apart -- both arrive as a thrown error -- so what the user reads is the reason itself.
const EXPIRED_REASON = "credentials expired — please reconnect";
const DENIED_REASON = "You do not have access to this thing.";

let harness: Harness;
let interceptor: NetworkInterceptor;

beforeAll(async () => {
  // No handlers: nothing here should make an outbound request at all, so every one is a failure.
  // The fetch-probe case below is what proves this is actually wired up.
  interceptor = new NetworkInterceptor();
  interceptor.install();
  harness = await startTestGatekeeperHarness();
});

afterAll(async () => {
  // Any outbound request means a test reached for the real internet. Asserted once for the whole file
  // rather than per test: the tests run concurrently, so an afterEach would be inspecting and clearing
  // state that sibling tests are still using.
  const unmocked = interceptor.getUnmockedCalls();
  await harness?.server.close();
  interceptor.uninstall();
  interceptor.reset();
  expect(unmocked).toEqual([]);
});

// Each test gets its own RPC session, so a disposal in one can't disturb another running alongside.
async function withSession<T>(body: (api: RpcStub<PublicApi>) => Promise<T>): Promise<T> {
  const publicApi = connect(harness.url);
  try {
    return await body(publicApi);
  } finally {
    publicApi[Symbol.dispose]();
  }
}

function thingUrl(name: string): string {
  return `https://gadgets-test.example/things/${name}`;
}

/** Mint this user's test-gatekeeper account -- no auth flow -- and read it back. */
async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(a => a.vendorId === TEST_VENDOR_ID) ?? null;
  });
}

/**
 * Tell the gatekeeper what to do the next time it's asked to admit `label` as an observer --
 * everywhere, or only at the binding `resourceUrl` names (a resource-specific outcome wins).
 */
async function setVerifyOutcome(
    label: string, outcome: { allow: true } | { allow: false; reason: string },
    resourceUrl?: string): Promise<void> {
  const res = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER, "http://gatekeeper-test.test/control/verify-outcome",
    { method: "POST", body: JSON.stringify({ label, resourceUrl, ...outcome }) });
  if (res.status !== 204) {
    // The control route answers a rejected body with 400 and a reason, so surface it here rather
    // than leaving a bare status to be puzzled over.
    throw new Error(`Setting the verify outcome failed with ${res.status}: ${await res.text()}`);
  }
}

type ObserverEvent = { resourceUrl: string; type: "add" | "remove"; id: string };

/** The addObserver()/removeObserver() calls one binding's gatekeeper has seen, in order. */
async function observerEvents(resourceUrl: string): Promise<ObserverEvent[]> {
  const res = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER, "http://gatekeeper-test.test/control/observer-events",
    { method: "POST", body: JSON.stringify({ resourceUrl }) });
  if (res.status !== 200) {
    throw new Error(`Reading observer events failed with ${res.status}: ${await res.text()}`);
  }
  return (await res.json() as { events: ObserverEvent[] }).events;
}

async function ambientVerificationCount(label: string): Promise<number> {
  const res = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER, "http://gatekeeper-test.test/control/ambient-verification-count",
    { method: "POST", body: JSON.stringify({ label }) });
  if (res.status !== 200) {
    throw new Error(`Reading the ambient verification count failed with ${res.status}: ${await res.text()}`);
  }
  return (await res.json() as { count: number }).count;
}

type SharedGadget = {
  gadgetId: string;
  bobApi: RpcStub<AuthenticatedApi>;
  bobAccount: ConnectedAccount;
  /** Bob's account label: what the gatekeeper keys outcomes on and the Workshop names in a message. */
  bobLabel: string;
  /** Make the gatekeeper refuse Bob from now on, as if his credential lapsed between opens. */
  failBob(reason: string): Promise<void>;
};

// Alice creates a gadget bound to each thing, shares it with Bob as "build", and Bob gets his own
// account. Call failBob() to put the gadget into the state the bug lives in.
//
// `thingNames` names the fixture gatekeeper's "Test Thing" resources to bind, one gatekeeper each --
// thingUrl() turns each name into a resource URL. They also end up in the failure message the last
// two cases assert on ("Test Thing multi-a"), so pass something recognisable per test.
async function shareGadgetWithBob(
    publicApi: RpcStub<PublicApi>, thingNames: string[]): Promise<SharedGadget> {
  const [alice, bob] = nextUsernames("alice", "bob");

  const aliceApi = await signUp(publicApi, alice);
  // Bob must exist before he can be added as a collaborator.
  const bobApi = await signUp(publicApi, bob);

  const aliceAccount = await provisionAccount(aliceApi);

  const overseer = await aliceApi.newGadget();
  for (const thingName of thingNames) {
    await overseer.newGatekeeper(aliceAccount.id, thingUrl(thingName));
  }
  const { id: gadgetId } = await overseer.getMetadata();
  const collaborator = await overseer.addCollaborator(bob, "build");
  if (!collaborator) throw new Error(`Failed to share the gadget with ${bob}`);
  overseer[Symbol.dispose]();

  const bobAccount = await provisionAccount(bobApi);
  const bobLabel = accountLabel(bobAccount);

  return {
    gadgetId,
    bobApi,
    bobAccount,
    bobLabel,
    failBob: reason => setVerifyOutcome(bobLabel, { allow: false, reason }),
  };
}

// Bob opens the gadget, answering any observer prompt from `recorder`.
async function bobOpens(
    shared: SharedGadget, recorder: ObserverConfigRecorder): Promise<RpcStub<Overseer>> {
  const callback = stubFor(recorder);
  try {
    return await shared.bobApi.openGadget(shared.gadgetId, undefined, callback);
  } finally {
    callback[Symbol.dispose]();
  }
}

/** Open once and answer the prompt, which is what persists Bob's account choice. */
async function bobOpensAndCloses(shared: SharedGadget): Promise<ObserverConfigRecorder> {
  const recorder =
      new ObserverConfigRecorder().alwaysChoose(shared.bobAccount.id, MAX_OBSERVER_PROMPTS);
  (await bobOpens(shared, recorder))[Symbol.dispose]();
  return recorder;
}

describe("observer re-verification", () => {
  it.concurrent("lists the connections each sharing role must verify", async () => {
    await withSession(async publicApi => {
      const [alice] = nextUsernames("alice");
      using aliceApi = await signUp(publicApi, alice);
      const account = await provisionAccount(aliceApi);
      using overseer = await aliceApi.newGadget();

      using bound = await overseer.newGatekeeper(account.id, thingUrl("bound"));
      using unbound = await overseer.newGatekeeper(account.id, thingUrl("unbound"));
      if (!bound || !unbound) throw new Error("Failed to create test connections");

      using gadget = await overseer.createGadget("Test Gadget", undefined, "TEST_GADGET");
      await gadget.bind("TEST_THING", await bound.getId());

      await expect(overseer.listObserverRequirements("use")).resolves.toEqual([
        expect.objectContaining({
          gatekeeperId: await bound.getId(),
          vendorId: TEST_VENDOR_ID,
          resourceTitle: "Test Thing bound",
          resourceUrl: thingUrl("bound"),
        }),
      ]);
      await expect(overseer.listObserverRequirements("build")).resolves.toEqual([
        expect.objectContaining({ resourceTitle: "Test Ambient" }),
        expect.objectContaining({ resourceTitle: "Test Thing bound" }),
        expect.objectContaining({ resourceTitle: "Test Thing unbound" }),
      ]);
    });
  });

  it.concurrent("automatically uses the collaborator's ambient account without prompting",
      async () => {
    await withSession(async publicApi => {
      const [alice, bob] = nextUsernames("ambientalice", "ambientbob");
      const aliceApi = await signUp(publicApi, alice);
      const bobApi = await signUp(publicApi, bob);
      const aliceAccount = await provisionAccount(aliceApi);
      const bobAccount = await provisionAccount(bobApi);

      const ownerWorkspace = await aliceApi.newGadget();
      const { id: gadgetId } = await ownerWorkspace.getMetadata();
      const collaborator = await ownerWorkspace.addCollaborator(bob, "build");
      if (!collaborator) throw new Error(`Failed to share the gadget with ${bob}`);
      ownerWorkspace[Symbol.dispose]();

      // No ObserverConfigCallback is supplied. Opening can only succeed if the Workshop discovers
      // Bob's ambient account itself; the fixture records which account's verifier it receives.
      using sharedWorkspace = await bobApi.openGadget(gadgetId);
      await expect(sharedWorkspace.getMetadata()).resolves.toMatchObject({ id: gadgetId });
      expect(await ambientVerificationCount(accountLabel(bobAccount))).toBe(1);
      expect(await ambientVerificationCount(accountLabel(aliceAccount))).toBe(0);
    });
  });

  it.concurrent("prompts once on the collaborator's first open, with no failure attached",
      async () => {
    await withSession(async publicApi => {
      const shared = await shareGadgetWithBob(publicApi, ["first"]);
      const recorder =
      new ObserverConfigRecorder().alwaysChoose(shared.bobAccount.id, MAX_OBSERVER_PROMPTS);
      using overseer = await bobOpens(shared, recorder);

      expect(recorder.callCount).toBe(1);
      const need = recorder.needAt(0);
      expect(need.vendorId).toBe(TEST_VENDOR_ID);
      expect(need.failure).toBeUndefined();
      await expect(overseer.getMetadata()).resolves.toMatchObject({ id: shared.gadgetId });
    });
  });

  it.concurrent("re-prompts with the failed account when verification fails since the last open",
      async () => {
    await withSession(async publicApi => {
      const shared = await shareGadgetWithBob(publicApi, ["expire"]);
      // First open persists Bob's account choice, which is the state the bug lives in.
      expect((await bobOpensAndCloses(shared)).callCount).toBe(1);

      await shared.failBob(EXPIRED_REASON);

      // Second open: the choice is already persisted, so previously no prompt was built at all and the
      // open dead-ended. Now the overseer must re-prompt and say which account failed. Answering with
      // the same still-failing account spends the re-prompt budget, so the open then rejects.
      const second =
          new ObserverConfigRecorder().alwaysChoose(shared.bobAccount.id, MAX_OBSERVER_PROMPTS);
      await expect(bobOpens(shared, second)).rejects.toThrow(/could not confirm/i);

      expect(second.callCount).toBe(1);
      const need = second.needAt(0);
      expect(need.failure).toBeDefined();
      expect(need.failure!.accountId).toBe(shared.bobAccount.id);
      expect(need.failure!.reason).toContain(EXPIRED_REASON);
    });
  });

  it.concurrent("names the connection and account when the re-prompt budget is spent", async () => {
    await withSession(async publicApi => {
      const shared = await shareGadgetWithBob(publicApi, ["named"]);
      await bobOpensAndCloses(shared);
      await shared.failBob(EXPIRED_REASON);

      const second =
          new ObserverConfigRecorder().alwaysChoose(shared.bobAccount.id, MAX_OBSERVER_PROMPTS);
      const error = await bobOpens(shared, second).then(
        overseer => { overseer[Symbol.dispose](); return null; },
        (err: unknown) => err as Error);

      expect(error).not.toBeNull();
      // The whole point of the change: the failure is attributable. It names the binding, Bob's own
      // account label, and the gatekeeper's own reason -- not an anonymous refusal.
      expect(error!.message).toContain("Test Thing named");
      expect(error!.message).toContain(shared.bobLabel);
      expect(error!.message).toContain(EXPIRED_REASON);
      // One line per failed binding, so a single failure must not introduce stray newlines.
      expect(error!.message.split("\n").filter(l => l.includes(shared.bobLabel))).toHaveLength(1);
    });
  });

  it.concurrent("reports every failing binding in one re-prompt, not just the first", async () => {
    await withSession(async publicApi => {
      const shared = await shareGadgetWithBob(publicApi, ["multi-a", "multi-b"]);

      // Both bindings were uncovered on the first open, so both were asked about at once.
      const first = await bobOpensAndCloses(shared);
      expect(first.calls[0]).toHaveLength(2);

      await shared.failBob(EXPIRED_REASON);

      // Both bindings now fail in the same verification pass. The old code kept only the first error
      // and dropped the rest, so a second failing connection was invisible.
      const second =
          new ObserverConfigRecorder().alwaysChoose(shared.bobAccount.id, MAX_OBSERVER_PROMPTS);
      const error = await bobOpens(shared, second).then(
        overseer => { overseer[Symbol.dispose](); return null; },
        (err: unknown) => err as Error);

      expect(second.callCount).toBe(1);
      const needs = second.calls[0];
      expect(needs).toHaveLength(2);
      for (const need of needs) {
        expect(need.failure?.accountId).toBe(shared.bobAccount.id);
      }
      // And the terminal message accounts for both, one line each.
      expect(error!.message).toContain("Test Thing multi-a");
      expect(error!.message).toContain("Test Thing multi-b");
      expect(error!.message.split("\n").filter(l => l.includes(shared.bobLabel))).toHaveLength(2);
    });
  });

  it.concurrent("keeps a repaired pre-existing registration when another binding fails terminally",
      async () => {
    await withSession(async publicApi => {
      const shared = await shareGadgetWithBob(publicApi, ["keep-a", "keep-b"]);
      // First open persists Bob's choices and registers him with both gatekeepers.
      expect((await bobOpensAndCloses(shared)).callCount).toBe(1);

      // Between opens, only binding a lapses; b still verifies.
      await setVerifyOutcome(
        shared.bobLabel, { allow: false, reason: EXPIRED_REASON }, thingUrl("keep-a"));

      // Second open. Pass 1: a fails, b passes -> one re-prompt, about a alone. The responder --
      // which runs exactly between the two passes -- repairs a just as b lapses, so pass 2 has a
      // passing again and b failing terminally (the re-prompt budget is spent).
      const second = new ObserverConfigRecorder().respondWith(async needs => {
        await setVerifyOutcome(shared.bobLabel, { allow: true }, thingUrl("keep-a"));
        await setVerifyOutcome(
          shared.bobLabel, { allow: false, reason: EXPIRED_REASON }, thingUrl("keep-b"));
        return needs.map(n => ({ gatekeeperId: n.gatekeeperId, accountId: shared.bobAccount.id }));
      });
      await expect(bobOpens(shared, second)).rejects.toThrow(/could not confirm/i);

      expect(second.callCount).toBe(1);
      expect(second.calls[0]).toHaveLength(1);
      expect(second.needAt(0).failure?.reason).toContain(EXPIRED_REASON);

      // The failed open rolls back only observers registered *this* call. a's registration
      // predates the call and the persisted record still asserts it exists, so repairing it must
      // not reclassify it as newly added. The buggy rollback emitted exactly one remove here.
      const events = await observerEvents(thingUrl("keep-a"));
      expect(events.filter(e => e.type === "remove")).toEqual([]);
      // Both successful verifications registered it: the first open and the pass-2 repair.
      expect(events.filter(e => e.type === "add")).toHaveLength(2);
    });
  });

  it.concurrent("denies terminally with no prompt when the client offers no config channel",
      async () => {
    // The path a collaborator hits by favouriting or sharing a workspace from the sidebar, where
    // openGadget() is called without a callback. This message is the only thing they ever see.
    //
    // Uses a settled denial rather than an expiry, since there is nothing to repair here anyway.
    await withSession(async publicApi => {
      const shared = await shareGadgetWithBob(publicApi, ["nocb"]);
      await bobOpensAndCloses(shared);
      await shared.failBob(DENIED_REASON);

      const error = await shared.bobApi.openGadget(shared.gadgetId).then(
        () => null, (err: unknown) => err as Error);

      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/could not confirm/i);
      expect(error!.message).toContain(DENIED_REASON);
    });
  });
});

describe("harness", () => {
  it.concurrent("serves the Workshop worker", async () => {
    const res = await harness.server.fetch("/");
    expect(res.status).toBeLessThan(500);
  });

  it.concurrent("accepts an RPC session and reports server config", async () => {
    await withSession(async publicApi => {
      const config = await publicApi.getServerConfig();
      expect(config.signupsEnabled).toBe(true);
    });
  });

  it.concurrent("provisions a test-gatekeeper account with no auth flow", async () => {
    await withSession(async publicApi => {
      const [name] = nextUsernames("smoke");
      using api = await signUp(publicApi, name);
      const account = await provisionAccount(api);

      expect(account.vendorId).toBe(TEST_VENDOR_ID);
      expect(account.credentialsValid).toBe(true);
      expect(account.description.uniqueName).toMatch(/^test-[0-9a-f]{12}@gadgets-test\.example$/);
    });
  });

  it.concurrent("routes a Worker's own outbound fetch through the interceptor", async () => {
    // The negative half of the isolation guarantee. Every other test asserts that *no* unmocked
    // request happened, which would be equally true if Worker subrequests bypassed the patched
    // globalThis.fetch entirely and went straight out. So provoke one and check it was caught.
    //
    // The target is deliberately a real, resolvable host: pointing at something like .invalid would
    // fail whether or not the interception worked, which proves nothing.
    const target = "https://example.com/definitely-not-mocked";
    const res = await harness.fetchWorker(
      TEST_GATEKEEPER_WORKER, "http://gatekeeper-test.test/control/fetch-probe",
      { method: "POST", body: JSON.stringify({ url: target }) });

    // The interceptor's throw doesn't surface as a rejection inside the Worker: the harness proxies
    // outbound requests, and a proxy-side failure comes back as a synthetic 500. Either way the
    // request never left the machine, and example.com never answered 500.
    expect(await res.json()).toEqual({ status: 500 });

    // The recording is the actual proof that our handler chain saw it. Take just this entry, so
    // afterAll's assertion still catches anything a sibling let escape.
    expect(interceptor.takeUnmockedCalls(target)).toEqual([`GET ${target}`]);
  });
});
