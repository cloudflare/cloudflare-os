// Tests for the sensitive-data (`containsRestrictedData`) observation policy.
//
// A sensitive observation is blocked only while some *current collaborator* has not been verified
// (via `addObserver`) against the gatekeeper producing it; sharing itself stays available, since
// recipients are verified when they open. The observation also latches the workspace into a
// restricted mode: once latched, the workspace may not perform actions (nor fetch from the web,
// which has no client-reachable surface to assert here).
//
// The fixture gatekeeper's session drives all of this through the real ApprovalQueue funnel:
// `readThing(true)` records a `containsRestrictedData` observation, `doThing()` submits an action.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AuthenticatedApi, ObserverAccountChoice, Overseer, PublicApi,
} from "@gadgets/workshop-shared/api";
import type {
  SubmitExternalMessageResult,
} from "@gadgets/workshop-shared/external-message-gateway";
import {
  startTestGatekeeperHarness, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import {
  accountLabel, connect, listConnectedAccounts, logIn, MAX_OBSERVER_PROMPTS, nextUsernames,
  ObserverConfigRecorder, signUp, stubFor, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

let harness: Harness;
let interceptor: NetworkInterceptor;

beforeAll(async () => {
  interceptor = new NetworkInterceptor();
  interceptor.install();
  harness = await startTestGatekeeperHarness();
});

afterAll(async () => {
  const unmocked = interceptor.getUnmockedCalls();
  await harness?.server.close();
  interceptor.uninstall();
  interceptor.reset();
  expect(unmocked).toEqual([]);
});

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

async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(a => a.vendorId === TEST_VENDOR_ID) ?? null;
  });
}

/**
 * Tell the fixture gatekeeper whether to admit `label` as an observer -- everywhere, or (with
 * `resourceUrl`) at one bound resource only, which wins over the account-wide outcome.
 */
async function setVerifyOutcome(
    label: string, outcome: { allow: true } | { allow: false; reason: string },
    resourceUrl?: string): Promise<void> {
  const res = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER, "http://gatekeeper-test.test/control/verify-outcome",
    { method: "POST", body: JSON.stringify({ label, resourceUrl, ...outcome }) });
  if (res.status !== 204) {
    throw new Error(`Setting the verify outcome failed with ${res.status}: ${await res.text()}`);
  }
}

type Workspace = {
  gadgetId: string;
  overseer: RpcStub<Overseer>;
  alice: string;
  aliceApi: RpcStub<AuthenticatedApi>;
  /** The fixture session bound to the workspace's (first) gatekeeper. */
  session: any;
  gatekeeperId: number;
};

// Alice creates a workspace bound to one Test Thing and opens a session on its gatekeeper. Every
// test starts here; collaborators and links are layered on per test.
async function newWorkspace(publicApi: RpcStub<PublicApi>, thingName: string): Promise<Workspace> {
  const [alice] = nextUsernames("alice");
  const aliceApi = await signUp(publicApi, alice);
  const account = await provisionAccount(aliceApi);

  const overseer = await aliceApi.newGadget();
  const gatekeeper = await overseer.newGatekeeper(account.id, thingUrl(thingName));
  if (!gatekeeper) throw new Error("Failed to create the test connection");
  const gatekeeperId = await gatekeeper.getId();
  const session = await gatekeeper.openSession();
  const { id: gadgetId } = await overseer.getMetadata();
  return { gadgetId, overseer, alice, aliceApi, session, gatekeeperId };
}

// Sign Bob up, add him as a collaborator, and give him his own fixture account.
async function addBob(publicApi: RpcStub<PublicApi>, ws: Workspace): Promise<{
  bob: string;
  bobProfileId: string;
  bobApi: RpcStub<AuthenticatedApi>;
  bobAccount: ConnectedAccount;
  bobLabel: string;
}> {
  const [bob] = nextUsernames("bob");
  const bobApi = await signUp(publicApi, bob);
  const bobAccount = await provisionAccount(bobApi);
  const collaborator = await ws.overseer.addCollaborator(bob, "build");
  if (!collaborator) throw new Error(`Failed to share the gadget with ${bob}`);
  return {
    bob, bobProfileId: collaborator.profile.id, bobApi, bobAccount,
    bobLabel: accountLabel(bobAccount),
  };
}

// Bob opens the workspace, answering observer prompts with his own account. This is what writes
// his observer record, i.e. verifies him against every in-scope gatekeeper.
async function bobOpens(gadgetId: string, bobApi: RpcStub<AuthenticatedApi>,
                        bobAccount: ConnectedAccount): Promise<RpcStub<Overseer>> {
  const recorder = new ObserverConfigRecorder().alwaysChoose(bobAccount.id, MAX_OBSERVER_PROMPTS);
  const callback = stubFor(recorder);
  try {
    return await bobApi.openGadget(gadgetId, undefined, callback);
  } finally {
    callback[Symbol.dispose]();
  }
}

/**
 * Submit an external chat message as `callerEmail`, through the fixture worker's control surface
 * (and so through the Workshop's real ExternalMessageGateway entrypoint).
 */
async function submitExternalMessage(input: {
  callerEmail: string; gadgetKey: string; prompt: string;
}): Promise<SubmitExternalMessageResult> {
  const res = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER, "http://gatekeeper-test.test/control/submit-external-message",
    { method: "POST", body: JSON.stringify({
        chatKey: `chat-${input.gadgetKey}`, messageKey: crypto.randomUUID(),
        gadgetTitle: input.gadgetKey, ...input }) });
  if (res.status !== 200) {
    throw new Error(`submit-external-message failed with ${res.status}: ${await res.text()}`);
  }
  return await res.json() as SubmitExternalMessageResult;
}

/** The workspace id behind an external gadgetKey -- the DO id the gateway derives from it. */
async function externalGadgetId(gadgetKey: string): Promise<string> {
  const res = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER, "http://gatekeeper-test.test/control/external-gadget-id",
    { method: "POST", body: JSON.stringify({ gadgetKey }) });
  if (res.status !== 200) {
    throw new Error(`external-gadget-id failed with ${res.status}: ${await res.text()}`);
  }
  return (await res.json() as { gadgetId: string }).gadgetId;
}

describe("sensitive observations", () => {
  it.concurrent("latch restricted mode: actions are blocked and metadata reports it", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "latch");

      // Before the latch, actions submit fine and metadata is clean.
      await expect(ws.session.doThing()).resolves.toBeUndefined();
      expect((await ws.overseer.getMetadata()).containsRestrictedData).toBeFalsy();

      await expect(ws.session.readThing(true)).resolves.toContain("latch");

      expect((await ws.overseer.getMetadata()).containsRestrictedData).toBe(true);
      await expect(ws.session.doThing()).rejects.toThrow(/prohibited from performing actions/i);
      // Reads -- sensitive or not -- keep working.
      await expect(ws.session.readThing()).resolves.toContain("latch");
      await expect(ws.session.readThing(true)).resolves.toContain("latch");
    });
  });

  it.concurrent("an unredeemed share link does not block a sensitive observation", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "unredeemed");
      await ws.overseer.createShareLink("build", "never redeemed");

      // Nobody has redeemed the link, so nobody unverified can be watching: the observation
      // proceeds. (Redemption happens inside open(), where observer verification gates it.)
      await expect(ws.session.readThing(true)).resolves.toContain("unredeemed");
    });
  });

  it.concurrent("sharing stays available after the latch", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "share-after");
      await expect(ws.session.readThing(true)).resolves.toContain("share-after");

      // Sharing stays available after the latch, across every sharing RPC.
      const [carol] = nextUsernames("carol");
      await signUp(publicApi, carol);
      await expect(ws.overseer.addCollaborator(carol, "build")).resolves.toMatchObject({
        profile: expect.objectContaining({ id: expect.any(String) }),
      });
      const { linkId } = await ws.overseer.createShareLink("use", "post-latch");
      await expect(ws.overseer.newShareLinkKey(linkId)).resolves.toMatchObject({
        key: expect.any(String),
      });
    });
  });

  it.concurrent("an unverified collaborator blocks a sensitive observation", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "unverified");
      await addBob(publicApi, ws);

      // Bob has access but has never opened, so he holds no observer record for this gatekeeper.
      // He may hold a live session the moment he does open, so the observation must not proceed.
      await expect(ws.session.readThing(true)).rejects.toThrow(/has not been verified/i);
      // Non-sensitive reads are unaffected.
      await expect(ws.session.readThing()).resolves.toContain("unverified");
    });
  });

  it.concurrent("a verified collaborator allows the sensitive observation through", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "verified");
      const bob = await addBob(publicApi, ws);
      (await bobOpens(ws.gadgetId, bob.bobApi, bob.bobAccount))[Symbol.dispose]();

      await expect(ws.session.readThing(true)).resolves.toContain("verified");
    });
  });

  it.concurrent("a verified collaborator does not cover a gatekeeper added later", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "covered");
      const bob = await addBob(publicApi, ws);
      (await bobOpens(ws.gadgetId, bob.bobApi, bob.bobAccount))[Symbol.dispose]();

      // A second connection Bob has never been verified against.
      const accounts = await listConnectedAccounts(ws.aliceApi);
      const account = accounts.find(a => a.vendorId === TEST_VENDOR_ID)!;
      const late = await ws.overseer.newGatekeeper(account.id, thingUrl("late"));
      if (!late) throw new Error("Failed to create the second test connection");
      const lateSession: any = await late.openSession();

      await expect(lateSession.readThing(true)).rejects.toThrow(/has not been verified/i);
      // The gatekeeper Bob is verified against still reads fine.
      await expect(ws.session.readThing(true)).resolves.toContain("covered");
    });
  });

  it.concurrent("a collaborator can open a workspace that latched before they were added",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "open-after");
      await expect(ws.session.readThing(true)).resolves.toContain("open-after");

      // Bob's open runs observer verification, which the fixture admits by default, so the latch
      // does not shut him out.
      const bob = await addBob(publicApi, ws);
      using bobOverseer = await bobOpens(ws.gadgetId, bob.bobApi, bob.bobAccount);
      await expect(bobOverseer.getMetadata()).resolves.toMatchObject({
        id: ws.gadgetId,
        containsRestrictedData: true,
      });
    });
  });

  it.concurrent("a collaborator the gatekeeper refuses is denied at open, with its reason",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "refused");
      await expect(ws.session.readThing(true)).resolves.toContain("refused");

      const bob = await addBob(publicApi, ws);
      const reason = "You do not have access to this thing.";
      await setVerifyOutcome(bob.bobLabel, { allow: false, reason });

      // This is the strategy-A shape: enforcement lives in the gatekeeper's addObserver(), so
      // the user sees the gatekeeper's own message.
      const error = await bobOpens(ws.gadgetId, bob.bobApi, bob.bobAccount).then(
        overseer => { overseer[Symbol.dispose](); return null; },
        (err: unknown) => err as Error);
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/could not confirm/i);
      expect(error!.message).toContain(reason);
    });
  });

  it.concurrent("a failed re-verification scrubs coverage for just the failed producer",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "scrub");
      // A second producer, so the test can prove the scrub is scoped to the one that refused.
      const accounts = await listConnectedAccounts(ws.aliceApi);
      const account = accounts.find(a => a.vendorId === TEST_VENDOR_ID)!;
      const second = await ws.overseer.newGatekeeper(account.id, thingUrl("scrub-2"));
      if (!second) throw new Error("Failed to create the second test connection");
      const secondSession: any = await second.openSession();

      // Bob verifies against both producers, so both restricted reads are admitted.
      const bob = await addBob(publicApi, ws);
      (await bobOpens(ws.gadgetId, bob.bobApi, bob.bobAccount))[Symbol.dispose]();
      await expect(ws.session.readThing(true)).resolves.toContain("scrub");
      await expect(secondSession.readThing(true)).resolves.toContain("scrub-2");

      // Bob's access to the first producer's resource is revoked; his next open is denied...
      await setVerifyOutcome(
          bob.bobLabel, { allow: false, reason: "Access revoked." }, thingUrl("scrub"));
      await expect(bobOpens(ws.gadgetId, bob.bobApi, bob.bobAccount))
          .rejects.toThrow(/could not confirm/i);

      // ...and the failure scrubbed his persisted coverage for that producer, so its restricted
      // reads fail closed against his older live session rather than keep flowing to it...
      await expect(ws.session.readThing(true)).rejects.toThrow(/has not been verified/i);
      // ...while the producer he still passes stays covered (the scrub is scoped).
      await expect(secondSession.readThing(true)).resolves.toContain("scrub-2");

      // A repaired re-open re-verifies him and re-persists full coverage.
      await setVerifyOutcome(bob.bobLabel, { allow: true }, thingUrl("scrub"));
      (await bobOpens(ws.gadgetId, bob.bobApi, bob.bobAccount))[Symbol.dispose]();
      await expect(ws.session.readThing(true)).resolves.toContain("scrub");
    });
  });

  it.concurrent("a refused share-link recipient is rolled back and does not block later reads",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "refused-link");
      await expect(ws.session.readThing(true)).resolves.toContain("refused-link");

      const { key } = await ws.overseer.createShareLink("build", "refused recipient");

      const [dave] = nextUsernames("dave");
      const daveApi = await signUp(publicApi, dave);
      const daveAccount = await provisionAccount(daveApi);
      await setVerifyOutcome(
          accountLabel(daveAccount), { allow: false, reason: "You do not have access." });

      // Dave's open redeems the key, but observer verification then refuses him, which must roll
      // the redemption back rather than leave him persisted as a collaborator.
      const recorder =
          new ObserverConfigRecorder().alwaysChoose(daveAccount.id, MAX_OBSERVER_PROMPTS);
      const callback = stubFor(recorder);
      try {
        await expect(daveApi.openGadget(ws.gadgetId, key, callback))
            .rejects.toThrow(/could not confirm/i);
      } finally {
        callback[Symbol.dispose]();
      }

      // He is not a collaborator, so he does not count against sensitive-observation coverage.
      await expect(ws.overseer.listCollaborators()).resolves.toEqual([]);
      await expect(ws.session.readThing(true)).resolves.toContain("refused-link");
    });
  });

  it.concurrent("a pending share-key redemption grants no access to a concurrent open",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "pending");
      await expect(ws.session.readThing(true)).resolves.toContain("pending");

      const { key } = await ws.overseer.createShareLink("build", "pending recipient");

      const [dave] = nextUsernames("dave");
      const daveApi = await signUp(publicApi, dave);
      await provisionAccount(daveApi);

      // Gate Dave's observer-config prompt on a test-controlled deferred, holding his keyed open
      // mid-verification -- the redemption exists but is still pending.
      let refuseConfig!: (err: Error) => void;
      const gate = new Promise<ObserverAccountChoice[]>((_, reject) => { refuseConfig = reject; });
      const recorder = new ObserverConfigRecorder().respondWith(() => gate);
      const callback = stubFor(recorder);
      try {
        // Observe the eventual rejection immediately, so it can't surface as an unhandled
        // rejection while the mid-verification assertions below run.
        const gatedOpen = daveApi.openGadget(ws.gadgetId, key, callback).then(
          overseer => { overseer[Symbol.dispose](); return null; },
          (err: unknown) => err as Error);

        await waitFor("Dave's open to reach the configuration prompt",
            async () => recorder.callCount > 0 ? true : null);

        // While the redemption is pending it grants nothing: a concurrent keyless open is denied
        // by role (not sent through verification), and Dave does not count against
        // sensitive-observation coverage.
        await expect(daveApi.openGadget(ws.gadgetId)).rejects.toThrow(/don't have access/i);
        await expect(ws.session.readThing(true)).resolves.toContain("pending");

        refuseConfig(new Error("test declined the configuration prompt"));
        expect(await gatedOpen).not.toBeNull();
      } finally {
        callback[Symbol.dispose]();
      }

      // The refused redemption was severed: no collaborator, and reads stay unaffected.
      await expect(ws.overseer.listCollaborators()).resolves.toEqual([]);
      await expect(ws.session.readThing(true)).resolves.toContain("pending");
    });
  });

  it.concurrent("concurrent redemptions of the same key both verify", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "raced");
      const { key } = await ws.overseer.createShareLink("build", "raced");

      const [dave] = nextUsernames("dave");
      const daveApi = await signUp(publicApi, dave);
      const daveAccount = await provisionAccount(daveApi);

      const callbacks = [0, 1].map(() => stubFor(
          new ObserverConfigRecorder().alwaysChoose(daveAccount.id, MAX_OBSERVER_PROMPTS)));
      try {
        // Each open redeems the same key; the second finds the first's pending edge and settles
        // it independently, so neither is turned away and the grants collapse to one edge.
        const overseers = await Promise.all(
            callbacks.map(cb => daveApi.openGadget(ws.gadgetId, key, cb)));
        for (const overseer of overseers) overseer[Symbol.dispose]();
      } finally {
        for (const cb of callbacks) cb[Symbol.dispose]();
      }

      const collaborators = await ws.overseer.listCollaborators();
      expect(collaborators).toHaveLength(1);
      expect(collaborators[0].addedBy).toHaveLength(1);
      expect(collaborators[0].addedBy[0]).not.toHaveProperty("pending");
    });
  });

  it.concurrent("a role granted mid-verification is not returned by the redeeming open",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "mid-grant");
      // Bind the connection to a gadget so it falls in "use" verification scope: Dave's keyed
      // open then prompts for an account choice, which is where the test parks it.
      using gadget = await ws.overseer.createGadget("Test Gadget", undefined, "TEST_GADGET");
      await gadget.bind("TEST_THING", ws.gatekeeperId);

      const { key } = await ws.overseer.createShareLink("use", "mid-grant");

      const [dave] = nextUsernames("dave");
      const daveApi = await signUp(publicApi, dave);
      const daveAccount = await provisionAccount(daveApi);

      // Park Dave's keyed open at the configuration prompt; while it waits, Alice grants him
      // "build" directly. His verification covered only the "use" scope, so the open must hand
      // back a "use" capability -- the raise takes effect at his next open.
      let releaseConfig!: () => void;
      const gate = new Promise<void>(resolve => { releaseConfig = resolve; });
      const recorder = new ObserverConfigRecorder()
          .respondWith(async needs => {
            await gate;
            return needs.map(n => ({ gatekeeperId: n.gatekeeperId, accountId: daveAccount.id }));
          })
          .alwaysChoose(daveAccount.id, MAX_OBSERVER_PROMPTS - 1);
      const callback = stubFor(recorder);
      try {
        const gatedOpen = daveApi.openGadget(ws.gadgetId, key, callback);
        await waitFor("Dave's open to reach the configuration prompt",
            async () => recorder.callCount > 0 ? true : null);

        await ws.overseer.addCollaborator(dave, "build");

        releaseConfig();
        using daveOverseer = await gatedOpen;
        await expect(daveOverseer.getMetadata()).resolves.toMatchObject({ role: "use" });
      } finally {
        callback[Symbol.dispose]();
      }

      // A fresh open verifies at the raised role and yields it.
      using secondOpen = await bobOpens(ws.gadgetId, daveApi, daveAccount);
      await expect(secondOpen.getMetadata()).resolves.toMatchObject({ role: "build" });
    });
  });

  it.concurrent("a connection added mid-verification denies the redeeming open", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "mid-topology");
      await expect(ws.session.readThing(true)).resolves.toContain("mid-topology");

      const { key } = await ws.overseer.createShareLink("build", "mid-topology");

      const [dave] = nextUsernames("dave");
      const daveApi = await signUp(publicApi, dave);
      const daveAccount = await provisionAccount(daveApi);

      // Park Dave's keyed open at the configuration prompt; while it waits, Alice adds a second
      // connection. Dave's verification snapshot never covered it, so confirming him would admit
      // a collaborator the new producer never verified -- the open must be denied instead.
      let releaseConfig!: () => void;
      const gate = new Promise<void>(resolve => { releaseConfig = resolve; });
      const recorder = new ObserverConfigRecorder()
          .respondWith(async needs => {
            await gate;
            return needs.map(n => ({ gatekeeperId: n.gatekeeperId, accountId: daveAccount.id }));
          })
          .alwaysChoose(daveAccount.id, MAX_OBSERVER_PROMPTS - 1);
      const callback = stubFor(recorder);
      let added;
      try {
        const gatedOpen = daveApi.openGadget(ws.gadgetId, key, callback).then(
          overseer => { overseer[Symbol.dispose](); return null; },
          (err: unknown) => err as Error);

        await waitFor("Dave's open to reach the configuration prompt",
            async () => recorder.callCount > 0 ? true : null);

        const accounts = await listConnectedAccounts(ws.aliceApi);
        const account = accounts.find(a => a.vendorId === TEST_VENDOR_ID)!;
        added = await ws.overseer.newGatekeeper(account.id, thingUrl("mid-topology-late"));
        if (!added) throw new Error("Failed to create the second test connection");

        // Mid-window, Dave's redemption is still pending and grants nothing, so it does not
        // block the first connection's sensitive reads (unchanged behavior).
        await expect(ws.session.readThing(true)).resolves.toContain("mid-topology");

        releaseConfig();
        const error = await gatedOpen;
        expect(error).not.toBeNull();
        expect(error!.message).toMatch(/changed in this workspace while your access was being verified/i);
      } finally {
        callback[Symbol.dispose]();
      }

      // The denied redemption was reverted: no collaborator persists.
      await expect(ws.overseer.listCollaborators()).resolves.toEqual([]);

      // A fresh keyed open re-redeems and verifies against the full new topology, confirming
      // Dave...
      const retryCallback = stubFor(
          new ObserverConfigRecorder().alwaysChoose(daveAccount.id, MAX_OBSERVER_PROMPTS));
      try {
        (await daveApi.openGadget(ws.gadgetId, key, retryCallback))[Symbol.dispose]();
      } finally {
        retryCallback[Symbol.dispose]();
      }
      const collaborators = await ws.overseer.listCollaborators();
      expect(collaborators).toHaveLength(1);
      expect(collaborators[0].addedBy[0]).not.toHaveProperty("pending");

      // ...including against the added connection: its sensitive reads see him covered.
      const lateSession: any = await added.openSession();
      await expect(lateSession.readThing(true)).resolves.toContain("mid-topology-late");
    });
  });

  it.concurrent("a latched connection cannot be removed while the workspace is shared",
      async () => {
    await withSession(async publicApi => {
      // Latched but unshared: removal proceeds. (The latch itself persists; there is nobody
      // whose verification the record anchors.)
      const solo = await newWorkspace(publicApi, "remove-solo");
      await expect(solo.session.readThing(true)).resolves.toContain("remove-solo");
      const soloGatekeeper = await solo.overseer.getGatekeeperById(solo.gatekeeperId);
      await expect(soloGatekeeper.remove()).resolves.toBeUndefined();

      // Latched and shared: the record is what Bob's verification runs against, so removing it
      // would let him open unchecked while the restricted data persists.
      const ws = await newWorkspace(publicApi, "remove-shared");
      await expect(ws.session.readThing(true)).resolves.toContain("remove-shared");
      await addBob(publicApi, ws);
      const gatekeeper = await ws.overseer.getGatekeeperById(ws.gatekeeperId);
      await expect(gatekeeper.remove()).rejects.toThrow(/remove all collaborators/i);
      // The refused removal left the connection intact.
      await expect(ws.session.readThing()).resolves.toContain("remove-shared");
    });
  });

  it.concurrent("a latched connection cannot be removed while a share link is outstanding",
      async () => {
    await withSession(async publicApi => {
      // An unredeemed link creates no collaborator state, but its keys are multi-redeemable and
      // never expire: redemption is gated at open() only while the gatekeeper record exists, so
      // removing the record now would let a later recipient open unchecked.
      const ws = await newWorkspace(publicApi, "remove-linked");
      await expect(ws.session.readThing(true)).resolves.toContain("remove-linked");
      const { linkId } = await ws.overseer.createShareLink("build", "outstanding");

      const gatekeeper = await ws.overseer.getGatekeeperById(ws.gatekeeperId);
      await expect(gatekeeper.remove()).rejects.toThrow(/revoke all share links/i);
      // The refused removal left the connection intact.
      await expect(ws.session.readThing()).resolves.toContain("remove-linked");

      // Nobody redeemed the link, so revoking it affects no collaborator (no revocation restart)
      // and unblocks the removal.
      await expect(ws.overseer.revokeShareLink(linkId, [])).resolves.toEqual([]);
      await expect(gatekeeper.remove()).resolves.toBeUndefined();
    });
  });

  it.concurrent("the removal guard is scoped to the connection that read the sensitive data",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "scoped-producer");
      // A second connection that never reads anything sensitive.
      const accounts = await listConnectedAccounts(ws.aliceApi);
      const account = accounts.find(a => a.vendorId === TEST_VENDOR_ID)!;
      const bystander = await ws.overseer.newGatekeeper(account.id, thingUrl("scoped-bystander"));
      if (!bystander) throw new Error("Failed to create the second test connection");

      // Only the first connection reads restricted data; share after the latch.
      await expect(ws.session.readThing(true)).resolves.toContain("scoped-producer");
      await addBob(publicApi, ws);

      // The latch is workspace-wide, but only the producer anchors verification: the bystander
      // stays removable while shared, the producer does not.
      await expect(bystander.remove()).resolves.toBeUndefined();
      const producer = await ws.overseer.getGatekeeperById(ws.gatekeeperId);
      await expect(producer.remove()).rejects.toThrow(/remove all collaborators/i);
      await expect(ws.session.readThing()).resolves.toContain("scoped-producer");
    });
  });

  it.concurrent("a workspace whose sensitive-data producer was removed can no longer be shared",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "unshareable");
      await expect(ws.session.readThing(true)).resolves.toContain("unshareable");

      // Unshared, so removal is allowed -- but the restricted data (and the latch) outlive it.
      const gatekeeper = await ws.overseer.getGatekeeperById(ws.gatekeeperId);
      await expect(gatekeeper.remove()).resolves.toBeUndefined();

      // With the producer's record gone there is nothing to verify a new collaborator against,
      // so the grant-creating mutators refuse.
      const [carol] = nextUsernames("carol");
      await signUp(publicApi, carol);
      await expect(ws.overseer.addCollaborator(carol, "build"))
          .rejects.toThrow(/can no longer be shared/i);
      await expect(ws.overseer.createShareLink("use", "too late"))
          .rejects.toThrow(/can no longer be shared/i);
    });
  });

  it.concurrent("removal unblocks the observation and tears down the observer record",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "removal");
      const bob = await addBob(publicApi, ws);
      (await bobOpens(ws.gadgetId, bob.bobApi, bob.bobAccount))[Symbol.dispose]();
      await expect(ws.session.readThing(true)).resolves.toContain("removal");

      // Removing Bob triggers the revocation restart: the DO aborts shortly after this call
      // returns, killing every stub from this connection. Everything past this point runs on a
      // fresh connection, retried across the abort window.
      await ws.overseer.removeCollaborator(bob.bobProfileId, []);

      const reopened = await waitFor("the workspace to come back after the revocation restart",
          async () => {
        const publicApi2 = connect(harness.url);
        try {
          const aliceApi = await logIn(publicApi2, ws.alice);
          const overseer = await aliceApi.openGadget(ws.gadgetId);
          const gatekeeper = await overseer.getGatekeeperById(ws.gatekeeperId);
          const session: any = await gatekeeper.openSession();
          // Probe with a benign read, so a session felled by the abort retries here rather than
          // failing an assertion below.
          await session.readThing();
          return { publicApi2, overseer, session };
        } catch {
          publicApi2[Symbol.dispose]();
          return null;
        }
      });

      try {
        // Bob's collaborator record lingers in storage (lazy revocation), but he is no longer
        // reachable from the owner, so he no longer blocks the observation.
        await expect(reopened.session.readThing(true)).resolves.toContain("removal");

        // Removal also tore down his observer record, so re-adding him must not silently restore
        // his coverage: he blocks again until he re-opens (which re-verifies him).
        await reopened.overseer.addCollaborator(bob.bob, "build");
        await expect(reopened.session.readThing(true)).rejects.toThrow(/has not been verified/i);
      } finally {
        reopened.publicApi2[Symbol.dispose]();
      }
    });
  });

  it.concurrent("the external-message path verifies collaborators like open() does", async () => {
    await withSession(async publicApi => {
      const [alice, bob, carol] = nextUsernames("alice", "bob", "carol");
      const aliceApi = await signUp(publicApi, alice);
      const aliceAccount = await provisionAccount(aliceApi);
      const gadgetKey = `external-${crypto.randomUUID()}`;

      // Alice creates the workspace through the external channel. No test user has an AI model,
      // so a submission that passes the authorization gate is rejected with the model message --
      // which is what tells "passed the gate" apart from a gate denial below.
      await expect(submitExternalMessage({ callerEmail: alice, gadgetKey, prompt: "hello" }))
          .resolves.toMatchObject({
            accepted: false, message: expect.stringMatching(/AI model/i) });

      // Wire the workspace up over the web API: bind a Thing, latch restricted mode, add Bob.
      const gadgetId = await externalGadgetId(gadgetKey);
      using overseer = await aliceApi.openGadget(gadgetId);
      const gatekeeper = await overseer.newGatekeeper(aliceAccount.id, thingUrl("external"));
      if (!gatekeeper) throw new Error("Failed to create the test connection");
      const session: any = await gatekeeper.openSession();
      await expect(session.readThing(true)).resolves.toContain("external");

      const bobApi = await signUp(publicApi, bob);
      const bobAccount = await provisionAccount(bobApi);
      await overseer.addCollaborator(bob, "build");

      // A stranger is turned away by role, before verification is ever attempted.
      await signUp(publicApi, carol);
      await expect(submitExternalMessage({ callerEmail: carol, gadgetKey, prompt: "hi" }))
          .resolves.toMatchObject({
            accepted: false, message: expect.stringMatching(/do not have access/i) });

      // Bob has build access but has never opened, so he was never observer-verified. The agent's
      // reply could surface the restricted data the workspace already read, so the external path
      // must refuse him rather than fall through to the model check.
      await expect(submitExternalMessage({ callerEmail: bob, gadgetKey, prompt: "hi" }))
          .resolves.toMatchObject({
            accepted: false, message: expect.stringMatching(/could not be verified/i) });

      // Opening the workspace verifies him; the same submission now passes the gate and fails
      // only on the missing AI model, exactly like the owner's did.
      (await bobOpens(gadgetId, bobApi, bobAccount))[Symbol.dispose]();
      await expect(submitExternalMessage({ callerEmail: bob, gadgetKey, prompt: "hi" }))
          .resolves.toMatchObject({
            accepted: false, message: expect.stringMatching(/AI model/i) });
    });
  });
});
