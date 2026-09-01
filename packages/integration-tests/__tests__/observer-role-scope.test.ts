// Tests for role-scoped observer enforcement: a collaborator is held only to what their role's
// verification scope can actually cover ("use" collaborators are verified only against
// gadget-bound connections; see #inScopeGatekeepers in overseer.ts). So binding a connection into
// a gadget widens every "use" collaborator's scope, and since sessions are verified only at open(),
// that widening restarts the workspace: each client's next open re-verifies against the new scope.
// The external-message gate's role scoping is covered by external-message-verification.test.ts.
//
// This lives in its own file -- with its own harness, like every suite here -- and stays small on
// purpose: a DO reset makes the shared local harness briefly drop unrelated in-flight requests, so
// the concurrent tests of any suite that restarts a workspace pass on their current timing, and
// growing the file re-rolls those dice.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, Overseer, PublicApi } from "@gadgets/workshop-shared/api";
import {
  settleRestart, startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  connect, listConnectedAccounts, logIn, MAX_OBSERVER_PROMPTS, nextUsernames,
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

type Workspace = {
  gadgetId: string;
  overseer: RpcStub<Overseer>;
  alice: string;
  aliceApi: RpcStub<AuthenticatedApi>;
  /** The fixture session bound to the workspace's (first) gatekeeper. */
  session: RpcStub<TestSession>;
  gatekeeperId: number;
  /** Alice's test-gatekeeper account, for tests that add a second connection. */
  account: ConnectedAccount;
};

// Alice creates a workspace bound to one Test Thing and opens a session on its gatekeeper.
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
  return { gadgetId, overseer, alice, aliceApi, session, gatekeeperId, account };
}

// The owner's own reconnect after a restart, on a fresh connection: the reset fells every client of
// the workspace, so `ws`'s stubs -- and the whole session they came from -- are dead afterwards.
async function reopenAfterRestart(ws: Workspace): Promise<{
  publicApi: RpcStub<PublicApi>;
  session: RpcStub<TestSession>;
}> {
  await waitFor("the restart to fell the old workspace instance", () =>
      ws.session.readValue().then(() => null, () => true));

  return waitFor("the workspace to come back after the restart", async () => {
    const publicApi = connect(harness.url);
    try {
      const aliceApi = await logIn(publicApi, ws.alice);
      const overseer = await aliceApi.openGadget(ws.gadgetId);
      const gatekeeper = await overseer.getGatekeeperById(ws.gatekeeperId);
      const session = await gatekeeper.openSession() as RpcStub<TestSession>;
      // Probe with a benign read, so a session felled by the reset retries here rather than
      // failing an assertion below.
      await session.readValue();
      return { publicApi, session };
    } catch {
      publicApi[Symbol.dispose]();
      return null;
    }
  });
}

// A collaborator's session, opened on its own connection (the one their browser holds) and kept
// live until close(). Every case here needs one: what a widening restarts is a live session, so a
// collaborator who is only named in the sharing table has nothing to sever, and a case that opened
// and closed one would prove nothing about the role filter either way.
type HeldSession = { overseer: RpcStub<Overseer>, close: () => void };

async function holdSession(
    ws: Workspace, who: string,
    recorder: ObserverConfigRecorder = new ObserverConfigRecorder()): Promise<HeldSession> {
  const publicApi = connect(harness.url);
  try {
    const api = await logIn(publicApi, who);
    const callback = stubFor(recorder);
    try {
      const overseer = await api.openGadget(ws.gadgetId, undefined, callback);
      return {
        overseer,
        close: () => {
          overseer[Symbol.dispose]();
          publicApi[Symbol.dispose]();
        },
      };
    } finally {
      callback[Symbol.dispose]();
    }
  } catch (error) {
    publicApi[Symbol.dispose]();
    throw error;
  }
}

describe("role-scoped observer enforcement", () => {
  it.concurrent("a use collaborator is verified only against connections in their scope",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "use-scope");
      const [carol] = nextUsernames("carol");
      const carolApi = await signUp(publicApi, carol);
      const carolAccount = await provisionAccount(carolApi);
      const collaborator = await ws.overseer.addCollaborator(carol, "use");
      if (!collaborator) throw new Error(`Failed to share the gadget with ${carol}`);

      // No gadget binds the connection, so Carol's "use" verification scope is empty: her open
      // must not prompt (the recorder has no queued responses, so an unexpected prompt throws).
      const carolSession = await holdSession(ws, carol);
      try {
        // Carol holds no coverage for the connection and never will while it stays unbound, but
        // that is enforced against her open, not against the owner's own use of the connection.
        await expect(ws.session.readValue()).resolves.toBe(42);

        // Binding the connection to a gadget (pure storage writes; no gadget code runs) brings it
        // into "use" scope. That widens what Carol's live session must be verified against, and a
        // live session is never re-verified in place -- so the workspace restarts instead.
        using gadget = await ws.overseer.createGadget("Test Gadget", undefined, "TEST_GADGET");
        await gadget.bind("TEST_THING", ws.gatekeeperId);
      } finally {
        carolSession.close();
      }

      const reopened = await reopenAfterRestart(ws);
      try {
        // The owner is back on the workspace with a working session: the restart is a re-open for
        // everyone, not a lockout.
        await expect(reopened.session.readValue()).resolves.toBe(42);

        // Carol's forced re-open is where the newly in-scope connection gets verified, and she is
        // asked about exactly it -- the one connection her role's scope just gained.
        const recorder =
            new ObserverConfigRecorder().alwaysChoose(carolAccount.id, MAX_OBSERVER_PROMPTS);
        const carolReopened = await holdSession(ws, carol, recorder);
        carolReopened.close();
        expect(recorder.callCount).toBe(1);
        expect(recorder.calls[0].map(need => need.gatekeeperId)).toEqual([ws.gatekeeperId]);
      } finally {
        reopened.publicApi[Symbol.dispose]();
      }
    });
  });

  it.concurrent("binding a connection already in \"use\" scope does not restart the workspace",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "rebind");
      using gadget = await ws.overseer.createGadget("Test Gadget", undefined, "TEST_GADGET");

      // Bind before the workspace is shared: the connection is in "use" scope from here on, and
      // with no collaborators yet there is nothing to restart for.
      await gadget.bind("TEST_THING", ws.gatekeeperId);

      const [carol] = nextUsernames("carol");
      const carolApi = await signUp(publicApi, carol);
      const carolAccount = await provisionAccount(carolApi);
      if (!await ws.overseer.addCollaborator(carol, "use")) {
        throw new Error(`Failed to share the gadget with ${carol}`);
      }

      // Carol's open verifies her against the bound connection -- her whole scope.
      const recorder =
          new ObserverConfigRecorder().alwaysChoose(carolAccount.id, MAX_OBSERVER_PROMPTS);
      const carolSession = await holdSession(ws, carol, recorder);
      try {
        expect(recorder.callCount).toBe(1);
        expect(recorder.calls[0].map(need => need.gatekeeperId)).toEqual([ws.gatekeeperId]);

        // A second name onto the same connection widens nobody's scope: Carol is already verified
        // against it. Severing her live session would be disruption bought for nothing.
        await gadget.bind("TEST_THING_AGAIN", ws.gatekeeperId);
        await settleRestart();
        await expect(ws.session.readValue()).resolves.toBe(42);
        await expect(carolSession.overseer.getMetadata()).resolves.toMatchObject(
            { id: ws.gadgetId });
      } finally {
        carolSession.close();
      }
    });
  });

  // The two roles widen independently, so each widening must leave the other role's workspace
  // alone. One test per direction: covering only one would leave half the filter unexercised.
  it.concurrent("binding does not restart a workspace whose collaborators are all \"build\"",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "build-only");
      const [bob] = nextUsernames("bob");
      const bobApi = await signUp(publicApi, bob);
      const bobAccount = await provisionAccount(bobApi);
      if (!await ws.overseer.addCollaborator(bob, "build")) {
        throw new Error(`Failed to share the gadget with ${bob}`);
      }

      // "build" scope is every account-requiring connection, so Bob is verified against this one at
      // his open, bound or not.
      const bobSession = await holdSession(
          ws, bob, new ObserverConfigRecorder().alwaysChoose(bobAccount.id, MAX_OBSERVER_PROMPTS));
      try {
        // Binding widens "use" scope only. The connection has been in every build collaborator's
        // scope since it was created, so Bob's requirements don't change and his live session --
        // the only one a restart would sever -- must be left alone.
        using gadget = await ws.overseer.createGadget("Test Gadget", undefined, "TEST_GADGET");
        await gadget.bind("TEST_THING", ws.gatekeeperId);
        await settleRestart();
        await expect(ws.session.readValue()).resolves.toBe(42);
        await expect(bobSession.overseer.getMetadata()).resolves.toMatchObject({ id: ws.gadgetId });
      } finally {
        bobSession.close();
      }
    });
  });

  it.concurrent("a new connection does not restart a workspace whose collaborators are all \"use\"",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "use-only");
      const [carol] = nextUsernames("carol");
      const carolApi = await signUp(publicApi, carol);
      await provisionAccount(carolApi);
      if (!await ws.overseer.addCollaborator(carol, "use")) {
        throw new Error(`Failed to share the gadget with ${carol}`);
      }

      // No gadget binds anything, so Carol's scope is empty and her open must not prompt.
      const carolSession = await holdSession(ws, carol);
      try {
        // The mirror image: a new connection enters "build" scope at once, but no gadget binds it,
        // so it is in no "use" collaborator's scope and Carol's requirements don't change either.
        using added = await ws.overseer.newGatekeeper(
            ws.account.id, thingUrl("use-only-extra"));
        if (!added) throw new Error("Failed to create the test connection");
        expect(await added.getId()).toBeGreaterThan(0);
        await settleRestart();
        await expect(ws.session.readValue()).resolves.toBe(42);
        await expect(carolSession.overseer.getMetadata()).resolves.toMatchObject(
            { id: ws.gadgetId });
      } finally {
        carolSession.close();
      }
    });
  });
});
