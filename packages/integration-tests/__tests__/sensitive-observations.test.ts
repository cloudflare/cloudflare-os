// Tests for the sensitive-data (`containsRestrictedData`) observation policy.
//
// Coverage is enforced at admission, not at the read: every collaborator passes the producing
// gatekeeper's `addObserver` at their most recent open and cannot open without passing it, and
// anything that widens what they must pass restarts the workspace so every live session re-opens
// against the new scope. So sensitive observations are not blocked by an unverified collaborator,
// and sharing stays available. The observation also latches the workspace into a restricted mode:
// once latched, the workspace may not perform actions (nor fetch from the web, which has no
// client-reachable surface to assert here).
//
// The fixture gatekeeper's session drives all of this through the real ApprovalQueue funnel:
// `readThing(true)` records a `containsRestrictedData` observation, `doThing()` submits an action.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AuthenticatedApi, Overseer, PublicApi,
} from "@gadgets/workshop-shared/api";
import {
  startTestGatekeeperHarness, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
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
  session: RpcStub<TestSession>;
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
  const session = await gatekeeper.openSession() as RpcStub<TestSession>;
  const { id: gadgetId } = await overseer.getMetadata();
  return { gadgetId, overseer, alice, aliceApi, session, gatekeeperId };
}

type Bob = {
  bob: string;
  bobProfileId: string;
  bobApi: RpcStub<AuthenticatedApi>;
  bobAccount: ConnectedAccount;
  bobLabel: string;
};

// Sign Bob up, add him as a collaborator, and give him his own fixture account.
async function addBob(publicApi: RpcStub<PublicApi>, ws: Workspace): Promise<Bob> {
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
// his observer record, i.e. verifies him against every in-scope gatekeeper. Pass a `recorder` to
// assert *which* connections the open asked him about.
async function bobOpens(gadgetId: string, bobApi: RpcStub<AuthenticatedApi>,
                        bobAccount: ConnectedAccount,
                        recorder?: ObserverConfigRecorder): Promise<RpcStub<Overseer>> {
  const callback = stubFor(
      recorder ?? new ObserverConfigRecorder().alwaysChoose(bobAccount.id, MAX_OBSERVER_PROMPTS));
  try {
    return await bobApi.openGadget(gadgetId, undefined, callback);
  } finally {
    callback[Symbol.dispose]();
  }
}

// Wait out a restart and come back on a fresh connection, returning the owner's re-opened
// workspace and a session on `gatekeeperId`.
//
// A restart aborts the DO shortly after the triggering call returns, killing every stub from the
// connection that made it. A probe on a fresh connection can only detect a DO that is *already*
// dead -- never one about to die -- so a reopen attempted inside the pre-abort window can fully
// succeed against the doomed instance and then lose its session under the assertions that follow.
// Hence two steps: watch the pre-restart session die, then reopen with retries.
async function reopenAfterRestart(ws: Workspace, gatekeeperId = ws.gatekeeperId): Promise<{
  publicApi: RpcStub<PublicApi>;
  overseer: RpcStub<Overseer>;
  session: RpcStub<TestSession>;
}> {
  await waitFor("the restart to fell the old workspace instance", () =>
      ws.session.readThing().then(() => null, () => true));

  return waitFor("the workspace to come back after the restart", async () => {
    const publicApi = connect(harness.url);
    try {
      const aliceApi = await logIn(publicApi, ws.alice);
      const overseer = await aliceApi.openGadget(ws.gadgetId);
      const gatekeeper = await overseer.getGatekeeperById(gatekeeperId);
      const session = await gatekeeper.openSession() as RpcStub<TestSession>;
      // Probe with a benign read, so a session felled by the abort retries here rather than
      // failing an assertion below.
      await session.readThing();
      return { publicApi, overseer, session };
    } catch {
      publicApi[Symbol.dispose]();
      return null;
    }
  });
}

// Bob's forced re-open, on the fresh connection his browser would reconnect with. The restart
// killed the whole session his `bobApi` came from -- every client of the workspace loses its
// connection, not just its workspace stubs -- so reusing it here would fail on a dead socket
// rather than exercising the re-verification this asserts.
async function bobReopens(
    ws: Workspace, bob: Bob, recorder: ObserverConfigRecorder): Promise<void> {
  const publicApi = connect(harness.url);
  try {
    const bobApi = await logIn(publicApi, bob.bob);
    (await bobOpens(ws.gadgetId, bobApi, bob.bobAccount, recorder))[Symbol.dispose]();
  } finally {
    publicApi[Symbol.dispose]();
  }
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

      // An outstanding link grants nobody anything until it is redeemed, and redemption happens
      // inside open() -- where verification runs -- so the observation proceeds.
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

  it.concurrent("an unverified collaborator does not block a sensitive observation", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "unverified");
      const bob = await addBob(publicApi, ws);

      // Bob has access but has never opened, so he holds no observer record for this gatekeeper
      // -- and no session either, because verification is a precondition of getting one. There is
      // nothing for the read to fail closed against.
      await expect(ws.session.readThing(true)).resolves.toContain("unverified");

      // Admission is where the coverage requirement bites: the gatekeeper refuses him, so his
      // open is denied and he never reaches the workspace, let alone the observation.
      await setVerifyOutcome(bob.bobLabel, { allow: false, reason: "You do not have access." });
      await expect(bobOpens(ws.gadgetId, bob.bobApi, bob.bobAccount))
          .rejects.toThrow(/could not confirm/i);

      // His refusal costs the owner nothing -- a first-ever failure scrubs no coverage, so
      // nothing was severed and reads keep flowing.
      await expect(ws.session.readThing(true)).resolves.toContain("unverified");
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

  it.concurrent("adding a connection restarts the workspace so collaborators re-verify",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "covered");
      const bob = await addBob(publicApi, ws);
      (await bobOpens(ws.gadgetId, bob.bobApi, bob.bobAccount))[Symbol.dispose]();

      // A second connection Bob has never been verified against. It is in his verification scope
      // the moment it exists -- a "build" session can open a session on it with no observer check
      // -- and his live session was admitted without it, so adding it severs every session.
      const accounts = await listConnectedAccounts(ws.aliceApi);
      const account = accounts.find(a => a.vendorId === TEST_VENDOR_ID)!;
      const late = await ws.overseer.newGatekeeper(account.id, thingUrl("late"));
      if (!late) throw new Error("Failed to create the second test connection");
      const lateId = await late.getId();

      const reopened = await reopenAfterRestart(ws, lateId);
      try {
        // Nothing is blocked: the owner reads restricted data through the new connection...
        await expect(reopened.session.readThing(true)).resolves.toContain("late");

        // ...and Bob's forced re-open is where it gets verified. He is asked about exactly it,
        // since his coverage for the connections that predate it survived.
        const recorder = new ObserverConfigRecorder()
            .alwaysChoose(bob.bobAccount.id, MAX_OBSERVER_PROMPTS);
        await bobReopens(ws, bob, recorder);
        expect(recorder.callCount).toBe(1);
        expect(recorder.calls[0].map(need => need.gatekeeperId)).toEqual([lateId]);
      } finally {
        reopened.publicApi[Symbol.dispose]();
      }
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
      // Added before Bob, so it widens nobody's scope and restarts nothing.
      const accounts = await listConnectedAccounts(ws.aliceApi);
      const account = accounts.find(a => a.vendorId === TEST_VENDOR_ID)!;
      const second = await ws.overseer.newGatekeeper(account.id, thingUrl("scrub-2"));
      if (!second) throw new Error("Failed to create the second test connection");
      const secondSession = await second.openSession() as RpcStub<TestSession>;

      // Bob verifies against both producers.
      const bob = await addBob(publicApi, ws);
      (await bobOpens(ws.gadgetId, bob.bobApi, bob.bobAccount))[Symbol.dispose]();
      await expect(ws.session.readThing(true)).resolves.toContain("scrub");
      await expect(secondSession.readThing(true)).resolves.toContain("scrub-2");

      // Bob's access to the first producer's resource is revoked; his next open is denied...
      await setVerifyOutcome(
          bob.bobLabel, { allow: false, reason: "Access revoked." }, thingUrl("scrub"));
      await expect(bobOpens(ws.gadgetId, bob.bobApi, bob.bobAccount))
          .rejects.toThrow(/could not confirm/i);

      // ...and because the failure shrank what his record claims, it severs the sessions that
      // claim admitted -- including the one he opened while it still covered that producer.
      const reopened = await reopenAfterRestart(ws);
      try {
        // The owner's reads keep flowing throughout: Bob cannot be admitted again without
        // re-verifying, which is the whole of the enforcement.
        await expect(reopened.session.readThing(true)).resolves.toContain("scrub");

        // A repaired re-open asks him about exactly the producer that refused: the scrub took
        // his coverage for that one and left the other intact.
        await setVerifyOutcome(bob.bobLabel, { allow: true }, thingUrl("scrub"));
        const recorder = new ObserverConfigRecorder()
            .alwaysChoose(bob.bobAccount.id, MAX_OBSERVER_PROMPTS);
        await bobReopens(ws, bob, recorder);
        expect(recorder.callCount).toBe(1);
        expect(recorder.calls[0].map(need => need.gatekeeperId)).toEqual([ws.gatekeeperId]);
      } finally {
        reopened.publicApi[Symbol.dispose]();
      }
    });
  });

  it.concurrent("a refused share-link recipient persists as a collaborator without blocking reads",
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

      // Dave's open redeems the key -- writing a real edge -- and observer verification then
      // refuses him. One-step redemption accepts the residue: he persists as an unverified
      // collaborator (see the TODO on redeemShareKey).
      const recorder =
          new ObserverConfigRecorder().alwaysChoose(daveAccount.id, MAX_OBSERVER_PROMPTS);
      const callback = stubFor(recorder);
      try {
        await expect(daveApi.openGadget(ws.gadgetId, key, callback))
            .rejects.toThrow(/could not confirm/i);
      } finally {
        callback[Symbol.dispose]();
      }

      // The residue is a collaborator row, not access: he never opened, and he cannot open
      // without passing the same check. So the owner's reads are untouched -- and nothing was
      // severed either, since a first-ever failure has no persisted coverage to scrub.
      const collaborators = await ws.overseer.listCollaborators();
      expect(collaborators).toHaveLength(1);
      await expect(ws.session.readThing(true)).resolves.toContain("refused-link");
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
        // Each open redeems the same key; the edges deduplicate, so neither open is turned away
        // and the grants collapse to one edge.
        const overseers = await Promise.all(
            callbacks.map(cb => daveApi.openGadget(ws.gadgetId, key, cb)));
        for (const overseer of overseers) overseer[Symbol.dispose]();
      } finally {
        for (const cb of callbacks) cb[Symbol.dispose]();
      }

      const collaborators = await ws.overseer.listCollaborators();
      expect(collaborators).toHaveLength(1);
      expect(collaborators[0].addedBy).toHaveLength(1);
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

  it.concurrent("removal restarts the workspace and tears down the observer record", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "removal");
      const bob = await addBob(publicApi, ws);
      (await bobOpens(ws.gadgetId, bob.bobApi, bob.bobAccount))[Symbol.dispose]();
      await expect(ws.session.readThing(true)).resolves.toContain("removal");

      // Removing Bob triggers the revocation restart: the DO aborts shortly after this call
      // returns, killing every stub from this connection -- including the session Bob holds,
      // which is the point. Everything past here runs on a fresh connection.
      await ws.overseer.removeCollaborator(bob.bobProfileId, []);
      const reopened = await reopenAfterRestart(ws);

      try {
        // Bob's collaborator record lingers in storage (lazy revocation), and the owner's reads
        // are unaffected either way.
        await expect(reopened.session.readThing(true)).resolves.toContain("removal");

        // Removal also tore down his observer record, so re-adding him must not silently restore
        // his coverage: his next open has to name an account for the producer and pass
        // addObserver again.
        await reopened.overseer.addCollaborator(bob.bob, "build");
        const recorder = new ObserverConfigRecorder()
            .alwaysChoose(bob.bobAccount.id, MAX_OBSERVER_PROMPTS);
        await bobReopens(ws, bob, recorder);
        expect(recorder.calls[0].map(need => need.gatekeeperId)).toContain(ws.gatekeeperId);
      } finally {
        reopened.publicApi[Symbol.dispose]();
      }
    });
  });

  it.concurrent("ambient reconciliation preserves a shared restricted producer", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "ambient-reconcile");

      // Ambient capsule records aren't published to clients, but their workpiece ids are small
      // sequential integers, so probe for the one ensureAmbientCapsules provisioned at first open.
      const findAmbientIds = async (overseer: RpcStub<Overseer>) => {
        const found: number[] = [];
        for (let id = 0; id < ws.gatekeeperId + 4; id++) {
          try {
            const gatekeeper = await overseer.getGatekeeperById(id);
            if ((await gatekeeper.getTitle()) === "Test Ambient") found.push(id);
          } catch {
            // Not a gatekeeper workpiece.
          }
        }
        return found;
      };
      const [ambientId] = await findAmbientIds(ws.overseer);
      expect(ambientId).toBeDefined();

      // Latch through the ambient capsule, so it -- not the pasted connection -- is the producer.
      const ambient = await ws.overseer.getGatekeeperById(ambientId);
      const ambientSession = await ambient.openSession() as RpcStub<TestSession>;
      await expect(ambientSession.readThing(true)).resolves.toContain("Test Ambient");
      await addBob(publicApi, ws);

      // Replace the owner's singleton account: disconnecting and re-provisioning mints a new
      // accountId, so the existing capsule record is stale at the next reconcile.
      const accounts = await listConnectedAccounts(ws.aliceApi);
      const oldAccount = accounts.find(a => a.vendorId === TEST_VENDOR_ID)!;
      await ws.aliceApi.disconnectAccount(oldAccount.id);
      const newAccount = await provisionAccount(ws.aliceApi);
      expect(newAccount.id).not.toBe(oldAccount.id);

      // Reopen. Later opens run the capsule reconcile in the background, and provisioning the
      // replacement is itself a connection Bob has never been verified against -- so the
      // reconcile restarts the workspace out from under this connection. Come back on a fresh
      // one, then wait for the replacement's record to appear (proof the reconcile has run).
      (await ws.aliceApi.openGadget(ws.gadgetId))[Symbol.dispose]();
      const reopened = await reopenAfterRestart(ws);
      try {
        const ids = await waitFor("the replacement ambient capsule to be provisioned", async () => {
          const found = await findAmbientIds(reopened.overseer);
          return found.some(id => id !== ambientId) ? found : null;
        });

        // The stale record anchors Bob's verification, so the reconcile must have skipped it:
        // the record survives, and sharing -- which refuses once any producer's record is gone --
        // still works.
        expect(ids).toContain(ambientId);
        await expect(reopened.overseer.createShareLink("build", "still shareable"))
            .resolves.toMatchObject({ key: expect.any(String) });
      } finally {
        reopened.publicApi[Symbol.dispose]();
      }
    });
  });
});
