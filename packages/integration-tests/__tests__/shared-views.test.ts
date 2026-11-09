// The owner's view of a shared gadget (docs/sharing.md, "Shared views"), end to end over the
// fixture gatekeeper and real gadget facets: the owner's open clones the gadget into its view, a
// collaborator the fixture refuses gets that copy (the owner's storage, no bindings) instead of a
// refusal, one it admits gets the live gadget with no prompt, and turning the admin policy off
// restores the refusal.

import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AdminApi, AuthenticatedApi, GadgetClient, Overseer, WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { diffFiles } from "@gadgets/workshop-shared/code-change";
import {
  ADMIN_USERNAME, startTestGatekeeperHarness, TEST_VENDOR_ID, testControl, type Harness,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, connect, listConnectedAccounts, MAX_OBSERVER_PROMPTS, nextUsernames,
  ObserverConfigRecorder, signUp, stubFor, waitFor, WorkpieceRecorder, type ConnectedAccount,
} from "../src/rpc-client.js";

let harness: Harness;
let admin: RpcStub<AdminApi>;
const fileScope = new DisposableStack();
const network = new NetworkInterceptor();

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness({ enableGadgetExecution: true });
  const adminApi = fileScope.use(await signUp(fileScope.use(connect(harness.url)), ADMIN_USERNAME));
  admin = fileScope.use(await adminApi.getAdminApi());
});

afterAll(async () => {
  try {
    fileScope.dispose();
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

// Reads through the binding into storage, and shows what storage holds: the shape the view needs,
// since the view's copy has the storage and not the binding.
const SERVER = `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async read() {
    let value = await this.env.THING.readValue(false, false, undefined, ["finance.accounts"]);
    await this.ctx.storage.put("value", value);
    return value;
  }
  async stored() { return await this.ctx.storage.get("value"); }
  bindings() { return Object.keys(this.env); }
}`;

const CLIENT = `const value = await gadget.stored();
document.body.innerHTML = "<h1>Billing " + value + "</h1>";`;

async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
}

/** Author the gadget's code through the same human-only edit/merge API as the code editor. */
async function installCode(overseer: RpcStub<Overseer>, gadgetId: WorkpieceId,
                           workpieces: WorkpieceRecorder): Promise<void> {
  const summary = workpieces.summaries.get(gadgetId);
  if (summary?.type !== "gadget" || summary.commitId === undefined) {
    throw new Error("The new gadget has no committed head");
  }
  const chatId = await overseer.newChat("Build the billing view", null);
  await overseer.submitCodeChange(chatId, {
    generation: 0, revision: 0, clientId: "shared-views", seq: 1,
    pins: [{ gadgetId, baseCommit: summary.commitId }],
    change: diffFiles(new Map(), new Map([[gadgetId, new Map([
      ["server.js", SERVER], ["client.js", CLIENT],
    ])]])),
  });
  expect(await overseer.mergeChanges(chatId)).toEqual({ outcome: "merged" });
}

/** Bob gets the gadget, answering any prompt with his account; how he was admitted, and calls. */
async function bobGets(api: RpcStub<AuthenticatedApi>, workspaceId: string, gadgetId: WorkpieceId,
                       account?: ConnectedAccount) {
  using workspace = await api.openWorkspace(workspaceId);
  const recorder = new ObserverConfigRecorder();
  if (account) recorder.alwaysChoose(account.id, MAX_OBSERVER_PROMPTS);
  using callback = stubFor(recorder);
  using gadget: RpcStub<GadgetClient> =
      await workspace.getGadget(gadgetId, account ? callback : undefined);
  const mode = await gadget.getAccessMode();
  return { mode, prompts: recorder.calls.length, gadget: gadget.dup() };
}

it("serves the owner's view to whoever the data refuses, and live data to whoever it admits",
    async () => {
  using publicApi = connect(harness.url);
  const [alice, bob] = nextUsernames("viewalice", "viewbob");
  using owner = await signUp(publicApi, alice);
  const ownerAccount = await provisionAccount(owner);
  using overseer = await owner.newWorkspace();
  const { id: workspaceId, sharedViewsAvailable } = await overseer.getMetadata();
  expect(sharedViewsAvailable).toBe(true);
  const url = `https://gadgets-test.example/things/view-${crypto.randomUUID().slice(0, 8)}`;
  await testControl(harness, "report-subresources", { resourceUrl: url });
  using connection = await overseer.newGatekeeper(ownerAccount.id, url);
  if (!connection) throw new Error(`Failed to connect ${url}`);

  const workpieces = new WorkpieceRecorder();
  using subscriber = stubFor(workpieces);
  using _subscription = await overseer.subscribeToWorkpieces(subscriber);
  await workpieces.loaded;
  using gadget = await overseer.createGadget("Workers Paid billing", undefined, "BILLING");
  const gadgetId = await gadget.getId();
  await gadget.bind("THING", await connection.getId());
  await waitFor("the gadget's head", async () =>
    workpieces.summaries.get(gadgetId)?.type === "gadget" || null);
  await installCode(overseer, gadgetId, workpieces);

  // The owner reads through the binding, which the gadget keeps in storage. Nobody holds the
  // gadget yet, so this open takes no view.
  {
    using live = await gadget.connectToGadget();
    expect(await live.read()).toBe(42);
  }

  using bobConnection = connect(harness.url);
  using bobApi = await signUp(bobConnection, bob);
  const bobAccount = await provisionAccount(bobApi);
  expect(await overseer.addCollaborator(bob, { gadgetId })).not.toBeNull();
  await testControl(harness, "verify-outcome",
      { label: accountLabel(bobAccount), resourceUrl: url, subresource: "finance.accounts",
        allow: false, reason: "bob can't open finance.accounts" });

  // Opening the gadget is what takes the view.
  (await gadget.connectToGadget())[Symbol.dispose]();
  await waitFor("the owner's view", async () => {
    const summary = workpieces.summaries.get(gadgetId);
    return summary?.type === "gadget" && summary.viewTakenAt ? summary : null;
  });
  const audit = await overseer.listActions({ filter: "observation" });
  expect(audit.entries).toContainEqual(expect.objectContaining({
    resourceTitle: "Workers Paid billing",
    description: expect.objectContaining({ title: "Updated the view people see" }),
  }));
  using ownerView = await gadget.getView();
  expect(ownerView.owner.id).toBe(alice);

  // Bob, who never chose an account, opens silently and gets the view: the gadget's own UI and
  // code over a copy of the owner's storage, with no binding to read anything new through.
  const first = await bobGets(bobApi, workspaceId, gadgetId);
  using _first = first.gadget;
  expect(first.mode).toBe("view");
  expect((await first.gadget.getUiBundle()).jsCode).toContain("gadget.stored()");
  {
    using copy = await first.gadget.connectToGadget();
    expect(await copy.stored()).toBe(42);
    expect(await copy.bindings()).toEqual([]);
    await expect(copy.read()).rejects.toThrow();
  }
  await expect(first.gadget.export("static-html")).rejects.toThrow(/Unauthorized/);
  const [listed] = await overseer.listCollaborators();
  expect(listed!.lastOpened?.[gadgetId]?.mode).toBe("view");

  // Exploring while refused keeps the view.
  const refused = await bobGets(bobApi, workspaceId, gadgetId, bobAccount);
  using _refused = refused.gadget;
  expect(refused.mode).toBe("view");
  expect(refused.prompts).toBeGreaterThan(0);

  // Granted access, exploring admits him live and remembers his account...
  await testControl(harness, "verify-outcome",
      { label: accountLabel(bobAccount), resourceUrl: url, subresource: "finance.accounts",
        allow: true });
  const granted = await bobGets(bobApi, workspaceId, gadgetId, bobAccount);
  using _granted = granted.gadget;
  expect(granted.mode).toBe("live");

  // ...so a later refusal is a silent view, and access granted again a silent live open.
  await testControl(harness, "verify-outcome",
      { label: accountLabel(bobAccount), resourceUrl: url, subresource: "finance.accounts",
        allow: false, reason: "bob can't open finance.accounts" });
  const revoked = await bobGets(bobApi, workspaceId, gadgetId);
  using _revoked = revoked.gadget;
  expect(revoked.mode).toBe("view");
  await testControl(harness, "verify-outcome",
      { label: accountLabel(bobAccount), resourceUrl: url, subresource: "finance.accounts",
        allow: true });
  const silent = await bobGets(bobApi, workspaceId, gadgetId);
  using _silent = silent.gadget;
  expect(silent.mode).toBe("live");
  expect(silent.prompts).toBe(0);

  // With the policy off, the refusal is what it was before views.
  await testControl(harness, "verify-outcome",
      { label: accountLabel(bobAccount), resourceUrl: url, subresource: "finance.accounts",
        allow: false, reason: "bob can't open finance.accounts" });
  await admin.setSharedViews(false);
  try {
    await expect(bobGets(bobApi, workspaceId, gadgetId)).rejects.toThrow();
    expect((await overseer.getMetadata()).sharedViewsAvailable).toBe(false);
  } finally {
    await admin.setSharedViews(true);
  }
});
