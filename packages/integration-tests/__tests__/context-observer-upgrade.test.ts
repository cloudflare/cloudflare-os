// The Context Library's observer tracking carried across the upgrade that moves it into the
// Workshop: workspaces read private collections under the release before this one, whose
// gatekeeper recorded each collection itself. After the upgrade, the Workshop learns the gatekeeper
// has upgraded from the first thing it does differently -- refusing a collaborator's
// `addObserver()`, or authorizing a read with `authorizeTrackedObservation()` -- switches that
// workspace's connection to tracking, imports the record (`getHistoricalSubresources()`), and
// verifies collaborators against it. The release before is main as it was before the move, built by
// `build:upgrade-base`, and the upgrade is wrangler's storage-preserving `update()`.

import { afterAll, beforeAll, expect, it } from "vitest";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { MAX_OBSERVER_PROMPTS, ObserverConfigRecorder, stubFor } from "../src/rpc-client.js";
import {
  baseContextGatekeeper, contextSession, contextUser, DOCUMENT, newContextUser, privateWorkspace,
  upgradeContext,
} from "./context-fixtures.js";

/** The Workshop's refusal of an account that cannot read what a tracked connection recorded. */
const DENIED = "This account can't access some of the data this workspace read through this service.";

let harness: Harness;
const network = new NetworkInterceptor({ handlers: [] });

beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [baseContextGatekeeper()] });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

it("verifies collaborators against collections each workspace read before the upgrade", async () => {
  using stack = new DisposableStack();

  // ── Under the release before this one ──────────────────────────────────────────────────────
  // After the upgrade, a collaborator's admission is the first thing to reach one workspace's
  // connection, and its owner's next read the other's.
  const ownerBefore = stack.use(await newContextUser(harness, "contextupgradeowner"));
  const observerBefore = stack.use(await newContextUser(harness, "contextupgradeobserver"));
  const byAdmission = stack.use(await privateWorkspace(ownerBefore));
  const byRead = stack.use(await privateWorkspace(ownerBefore));
  for (const state of [byAdmission, byRead]) {
    expect(await state.session.read(state.docId)).toMatchObject({ content: DOCUMENT.body });
    await state.workspace.addCollaborator(observerBefore.username, "build");
  }

  // ── The upgrade ─────────────────────────────────────────────────────────────────────────────
  await upgradeContext(harness);

  // ── Under this tree's release ───────────────────────────────────────────────────────────────
  const owner = stack.use(await contextUser(harness, ownerBefore.username, true));
  const observer = stack.use(await contextUser(harness, observerBefore.username, true));
  const openAsObserver = (workspaceId: string, recorder: ObserverConfigRecorder) =>
    observer.api.openWorkspace(workspaceId, undefined, stack.use(stubFor(
      recorder.alwaysChoose(observer.account.id, MAX_OBSERVER_PROMPTS))));
  // Refused for the collection the workspace read, without the refusal naming it.
  const expectRefused = async ({ workspaceId, collection }: typeof byAdmission) => {
    const recorder = new ObserverConfigRecorder();
    await expect(openAsObserver(workspaceId, recorder)).rejects.toThrow(DENIED);
    const failure = recorder.needAt(0).failure;
    expect(failure).toMatchObject({ accountId: observer.account.id, reason: expect.stringContaining(DENIED) });
    expect(failure?.reason).not.toContain(collection.id);
    expect(failure?.reason).not.toContain(collection.title);
  };

  // No read since the upgrade, so only the imported record can refuse the collaborator.
  await expectRefused(byAdmission);
  const workspace = stack.use(await owner.api.openWorkspace(byAdmission.workspaceId));
  const { entries } = await workspace.listActions({ filter: "observation" });
  expect(entries.map(entry => entry.description.title)).toContain("Imported earlier reads");

  // The imported collection is checked live, like one read since.
  await owner.context.setContextCollectionEveryoneCanView(byAdmission.collection.id, true);
  const opened = stack.use(await openAsObserver(byAdmission.workspaceId, new ObserverConfigRecorder()));
  expect(await opened.getMetadata()).toMatchObject({ id: byAdmission.workspaceId, role: "build" });

  // The upgraded connection reads on, now tracked by the Workshop, which checks the collaborator.
  const { session } = stack.use(await contextSession(workspace));
  expect(await session.read(byAdmission.docId)).toMatchObject({ content: DOCUMENT.body });

  // Listing the collections reveals none of their contents, so here too only the imported record
  // can refuse the collaborator.
  const listed = stack.use(await contextSession(stack.use(await owner.api.openWorkspace(byRead.workspaceId))));
  expect((await listed.session.list()).entries.map(entry => entry.type === "collection" && entry.id))
    .toContain(byRead.collection.id);
  await expectRefused(byRead);
});
