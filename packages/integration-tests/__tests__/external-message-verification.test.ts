// Tests for the external-message authorization gate (authorizeCollaborator in overseer.ts):
// receiveExternalMessage() must hold a collaborator to the same observer verification open()
// applies -- non-interactively, since this path has no way to prompt for account configuration --
// and must deny an insufficient role *before* verification runs.
//
// These live in their own file -- with their own harness, like every suite here -- so the suite
// stays self-contained as the observer suites around it grow.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, PublicApi } from "@gadgets/workshop-shared/api";
import type {
  SubmitExternalMessageResult,
} from "@gadgets/workshop-shared/external-message-gateway";
import {
  startTestGatekeeperHarness, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import {
  accountLabel, connect, listConnectedAccounts, MAX_OBSERVER_PROMPTS, nextUsernames,
  ObserverConfigRecorder, signUp, stubFor, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

// Reason text shaped like what a gatekeeper actually reports on a settled denial. Its appearance
// in the gateway's reply below is what proves a live verification round trip happened.
const DENIED_REASON = "You do not have access to this thing.";

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

/** Tell the gatekeeper what to do the next time it's asked to admit `label` as an observer. */
async function setVerifyOutcome(
    label: string, outcome: { allow: true } | { allow: false; reason: string }): Promise<void> {
  const res = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER, "http://gatekeeper-test.test/control/verify-outcome",
    { method: "POST", body: JSON.stringify({ label, ...outcome }) });
  if (res.status !== 204) {
    throw new Error(`Setting the verify outcome failed with ${res.status}: ${await res.text()}`);
  }
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

describe("external-message verification", () => {
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

      // Wire the workspace up over the web API: connect a Thing (an account-requiring connection,
      // so collaborators must be observer-verified against it) and add Bob.
      const gadgetId = await externalGadgetId(gadgetKey);
      using overseer = await aliceApi.openGadget(gadgetId);
      const gatekeeper = await overseer.newGatekeeper(aliceAccount.id, thingUrl("external"));
      if (!gatekeeper) throw new Error("Failed to create the test connection");

      const bobApi = await signUp(publicApi, bob);
      const bobAccount = await provisionAccount(bobApi);
      await overseer.addCollaborator(bob, "build");

      // A stranger is turned away by role, before verification is ever attempted.
      await signUp(publicApi, carol);
      await expect(submitExternalMessage({ callerEmail: carol, gadgetKey, prompt: "hi" }))
          .resolves.toMatchObject({
            accepted: false, message: expect.stringMatching(/do not have access/i) });

      // Bob has build access but has never opened, so he was never observer-verified -- and this
      // path has no configuration channel to fix that. The agent's reply could surface anything
      // the workspace has already read, so the external path must refuse him rather than fall
      // through to the model check.
      await expect(submitExternalMessage({ callerEmail: bob, gadgetKey, prompt: "hi" }))
          .resolves.toMatchObject({
            accepted: false, message: expect.stringMatching(/could not be verified/i) });

      // Opening the workspace verifies him; the same submission now passes the gate and fails
      // only on the missing AI model, exactly like the owner's did.
      const callback = stubFor(
          new ObserverConfigRecorder().alwaysChoose(bobAccount.id, MAX_OBSERVER_PROMPTS));
      try {
        (await bobApi.openGadget(gadgetId, undefined, callback))[Symbol.dispose]();
      } finally {
        callback[Symbol.dispose]();
      }
      await expect(submitExternalMessage({ callerEmail: bob, gadgetKey, prompt: "hi" }))
          .resolves.toMatchObject({
            accepted: false, message: expect.stringMatching(/AI model/i) });

      // The gatekeeper now revokes Bob's underlying access. His persisted observer record is
      // untouched, so only a live addObserver re-verification on this submission can notice --
      // and the gatekeeper's own refusal reason appearing in the reply is the proof that round
      // trip happened, since nothing persisted in the Workshop contains it. An implementation
      // that merely checked the record would keep accepting him here.
      await setVerifyOutcome(accountLabel(bobAccount), { allow: false, reason: DENIED_REASON });
      const revoked = await submitExternalMessage({ callerEmail: bob, gadgetKey, prompt: "hi" });
      if (revoked.accepted) throw new Error("The revoked submission was accepted");
      expect(revoked.message).toMatch(/could not be verified/i);
      expect(revoked.message).toContain(DENIED_REASON);
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
      if (!await overseer.addCollaborator(dave, "use")) {
        throw new Error(`Failed to share the gadget with ${dave}`);
      }
      await expect(submitExternalMessage({ callerEmail: dave, gadgetKey, prompt: "hi" }))
          .resolves.toMatchObject({
            accepted: false, message: expect.stringMatching(/do not have access/i) });
    });
  });
});
