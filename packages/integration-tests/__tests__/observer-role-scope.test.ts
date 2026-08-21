// Tests for role-scoped observer enforcement: both the sensitive-observation coverage guard and
// the external-message authorization gate hold a collaborator only to what their role's
// verification scope can actually cover ("use" collaborators are verified only against
// gadget-bound connections; see #inScopeGatekeepers in overseer.ts).
//
// These live in their own file -- with their own harness, like every suite here -- rather than in
// sensitive-observations.test.ts, because that suite includes a revocation-restart test whose DO
// abort makes the shared local harness briefly drop unrelated in-flight requests; its concurrent
// tests pass with their current timing, but growing that file re-rolls those dice.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, Overseer, PublicApi } from "@gadgets/workshop-shared/api";
import type {
  SubmitExternalMessageResult,
} from "@gadgets/workshop-shared/external-message-gateway";
import {
  startTestGatekeeperHarness, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import {
  connect, listConnectedAccounts, MAX_OBSERVER_PROMPTS, nextUsernames, ObserverConfigRecorder,
  signUp, stubFor, waitFor, type ConnectedAccount,
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
  aliceApi: RpcStub<AuthenticatedApi>;
  /** The fixture session bound to the workspace's (first) gatekeeper. */
  session: any;
  gatekeeperId: number;
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
  const session = await gatekeeper.openSession();
  const { id: gadgetId } = await overseer.getMetadata();
  return { gadgetId, overseer, aliceApi, session, gatekeeperId };
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

describe("role-scoped observer enforcement", () => {
  it.concurrent("a use collaborator only blocks reads from connections in their scope",
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
      const emptyCallback = stubFor(new ObserverConfigRecorder());
      try {
        (await carolApi.openGadget(ws.gadgetId, undefined, emptyCallback))[Symbol.dispose]();
      } finally {
        emptyCallback[Symbol.dispose]();
      }

      // ensureObserver can never verify Carol against an unbound connection, so she must not
      // block its sensitive reads either -- demanding coverage her role can't gain would block
      // them forever.
      await expect(ws.session.readThing(true)).resolves.toContain("use-scope");

      // Binding the connection to a gadget (pure storage writes; no gadget code runs) brings it
      // into "use" scope. Carol is now in scope but uncovered, so the read blocks...
      using gadget = await ws.overseer.createGadget("Test Gadget", undefined, "TEST_GADGET");
      await gadget.bind("TEST_THING", ws.gatekeeperId);
      await expect(ws.session.readThing(true)).rejects.toThrow(/has not been verified/i);

      // ...and the error's remedy works: re-opening verifies her, which unblocks the read.
      const callback = stubFor(
          new ObserverConfigRecorder().alwaysChoose(carolAccount.id, MAX_OBSERVER_PROMPTS));
      try {
        (await carolApi.openGadget(ws.gadgetId, undefined, callback))[Symbol.dispose]();
      } finally {
        callback[Symbol.dispose]();
      }
      await expect(ws.session.readThing(true)).resolves.toContain("use-scope");
    });
  });

  it.concurrent("the external-message path denies a use collaborator by role, not verification",
      async () => {
    await withSession(async publicApi => {
      const [alice, dave] = nextUsernames("alice", "dave");
      const aliceApi = await signUp(publicApi, alice);
      const aliceAccount = await provisionAccount(aliceApi);
      const gadgetKey = `external-use-${crypto.randomUUID()}`;

      // Alice creates the workspace through the external channel (the AI-model rejection means
      // her submission passed the gate), then binds its connection to a gadget so it falls in
      // "use" verification scope.
      await expect(submitExternalMessage({ callerEmail: alice, gadgetKey, prompt: "hello" }))
          .resolves.toMatchObject({
            accepted: false, message: expect.stringMatching(/AI model/i) });
      const gadgetId = await externalGadgetId(gadgetKey);
      using overseer = await aliceApi.openGadget(gadgetId);
      const gatekeeper = await overseer.newGatekeeper(aliceAccount.id, thingUrl("external-use"));
      if (!gatekeeper) throw new Error("Failed to create the test connection");
      using gadget = await overseer.createGadget("Test Gadget", undefined, "TEST_GADGET");
      await gadget.bind("TEST_THING", await gatekeeper.getId());

      // Dave is in verification scope and unverified, but this path can never grant a "use"
      // collaborator agent access, so his role is checked before verification runs: he gets the
      // plain denial, not a verification failure he has no reason to go fix.
      await signUp(publicApi, dave);
      await overseer.addCollaborator(dave, "use");
      await expect(submitExternalMessage({ callerEmail: dave, gadgetKey, prompt: "hi" }))
          .resolves.toMatchObject({
            accepted: false, message: expect.stringMatching(/do not have access/i) });
    });
  });
});
