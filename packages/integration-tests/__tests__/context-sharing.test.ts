import { fileURLToPath, URL } from "node:url";
import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import type { ContextApi, ContextLibrary } from "../../gatekeeper-context/src/context-types.js";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, MAX_OBSERVER_PROMPTS, nextUsernames,
  ObserverConfigRecorder, signUp, stubFor, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";

const CONTEXT_DIR = fileURLToPath(new URL("../../gatekeeper-context/", import.meta.url));
const VENDOR_ID = "context";
const DOCUMENT_PATH = "plan.md";
const DOCUMENT = { description: "Owner-only launch plan", body: "Launch code: private-context." };
let harness: Harness;

type ContextUser = Disposable & {
  username: string;
  api: RpcStub<AuthenticatedApi>;
  account: ConnectedAccount;
  context: RpcStub<ContextApi>;
};
const network = new NetworkInterceptor({ handlers: [] });

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [{
      binding: "CONTEXT",
      dir: CONTEXT_DIR,
      // The task graph builds this tree before any test file boots a Worker.
      patch: config => { delete config.build; },
    }],
  });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

async function newAccount(prefix: string): Promise<ContextUser> {
  using stack = new DisposableStack();
  const [username] = nextUsernames(prefix);
  if (username === undefined) throw new Error("Missing test username");
  const api = stack.use(await signUp(stack.use(connect(harness.url)), username));
  await api.provisionAmbientAccount(VENDOR_ID);
  const account = await waitFor("the Context account to be provisioned", async () =>
    (await listConnectedAccounts(api)).find(entry => entry.vendorId === VENDOR_ID) ?? null);
  const frame = await api.getGatekeeperApp(VENDOR_ID);
  if (frame === null) throw new Error("The Context management app is unavailable");
  const context = stack.use(frame.ui as unknown as RpcStub<ContextApi>);
  return Object.assign(stack.move(), { username, api, account, context });
}

async function privateWorkspace(owner: ContextUser) {
  using stack = new DisposableStack();
  const collection = await owner.context.createContextCollection(
    `${owner.username} private collection`, "Private discovery metadata", "private");
  await owner.context.putContextDocument(collection.id, DOCUMENT_PATH, DOCUMENT);
  const workspace = stack.use(await owner.api.newWorkspace());
  const { id: workspaceId } = await workspace.getMetadata();
  const requirement = await waitFor("the workspace's ambient Context binding", async () =>
    (await workspace.listObserverRequirements("build"))
      .find(entry => entry.vendorId === VENDOR_ID) ?? null);
  const binding = stack.use(await workspace.getGatekeeperById(requirement.gatekeeperId));
  const session = stack.use(await binding.openSession() as RpcStub<ContextLibrary>);
  return Object.assign(stack.move(), { collection, workspace, workspaceId, session });
}

it.concurrent("top-level private collection metadata does not prevent a collaborator opening",
    async () => {
  using owner = await newAccount("contextlistingowner");
  using observer = await newAccount("contextlistingobserver");
  using state = await privateWorkspace(owner);
  const { collection, workspace, workspaceId, session } = state;

  // The collaborator has their own Context account, with no access to the owner's collection.
  expect(await observer.context.getContextCollectionMetadata(collection.id)).toBeNull();
  expect(await session.list()).toEqual({ entries: [{
    type: "collection", id: collection.id, title: collection.title,
    description: collection.description, documentCount: 1,
  }] });

  await workspace.addCollaborator(observer.username, "build");
  using opened = await observer.api.openWorkspace(workspaceId);
  expect(await opened.getMetadata()).toMatchObject({ id: workspaceId, role: "build" });
});

it.concurrent.each(["list", "read"] as const)(
  "a private collection's %s prevents a collaborator without collection access opening",
  async reveal => {
    using owner = await newAccount("contextcontentowner");
    using observer = await newAccount("contextcontentobserver");
    using state = await privateWorkspace(owner);
    const { collection, workspace, workspaceId, session } = state;
    const docId = `${collection.id}/${DOCUMENT_PATH}`;

    expect(await observer.context.getContextCollectionMetadata(collection.id)).toBeNull();
    if (reveal === "list") {
      expect(await session.list({ collectionId: collection.id })).toMatchObject({
        collectionId: collection.id,
        entries: [{ type: "document", docId, path: DOCUMENT_PATH, description: DOCUMENT.description }],
      });
    } else {
      expect(await session.read(docId)).toMatchObject({ docId, content: DOCUMENT.body });
    }

    await workspace.addCollaborator(observer.username, "build");
    const recorder = new ObserverConfigRecorder()
      .alwaysChoose(observer.account.id, MAX_OBSERVER_PROMPTS);
    using callback = stubFor(recorder);
    await expect(observer.api.openWorkspace(workspaceId, undefined, callback))
      .rejects.toThrow();
    const failure = recorder.needAt(0).failure;
    expect(failure).toMatchObject({ accountId: observer.account.id, reason: expect.any(String) });
    expect(failure?.reason).not.toContain(collection.id);
    expect(failure?.reason).not.toContain(collection.title);
  },
);
