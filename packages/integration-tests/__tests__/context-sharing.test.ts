import { afterAll, beforeAll, expect, it } from "vitest";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { MAX_OBSERVER_PROMPTS, ObserverConfigRecorder, stubFor } from "../src/rpc-client.js";
import { contextGatekeeper, DOCUMENT, DOCUMENT_PATH, newContextUser, privateWorkspace } from "./context-fixtures.js";

let harness: Harness;
const network = new NetworkInterceptor({ handlers: [] });

beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [contextGatekeeper()] });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

it.concurrent("top-level private collection metadata does not prevent a collaborator opening",
    async () => {
  using owner = await newContextUser(harness, "contextlistingowner");
  using observer = await newContextUser(harness, "contextlistingobserver");
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
  "a private collection's %s admits only collaborators who can read the collection",
  async reveal => {
    using owner = await newContextUser(harness, "contextcontentowner");
    using observer = await newContextUser(harness, "contextcontentobserver");
    using state = await privateWorkspace(owner);
    const { collection, workspace, workspaceId, session, docId } = state;

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

    // Access to the collection is checked live, so once it is theirs to read they may open.
    await owner.context.setContextCollectionEveryoneCanView(collection.id, true);
    using opened = await observer.api.openWorkspace(workspaceId, undefined, callback);
    expect(await opened.getMetadata()).toMatchObject({ id: workspaceId, role: "build" });
  },
);
