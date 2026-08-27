import { afterAll, beforeAll, expect, it } from "vitest";
import type { PresenceParticipant, PresenceSubscriber } from "@gadgets/workshop-shared/api";
import { type Harness, startHarness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { mockChatCompletion } from "../src/mock-model.js";
import { RpcTarget, connect, nextUsernames, signUp, stubFor, waitFor } from "../src/rpc-client.js";

class PresenceRecorder extends RpcTarget implements PresenceSubscriber {
  readonly participants = new Map<string, PresenceParticipant>();
  init(participants: PresenceParticipant[]): void {
    this.participants.clear();
    for (const participant of participants) this.participants.set(participant.key, participant);
  }

  add(participant: PresenceParticipant): void {
    this.participants.set(participant.key, participant);
  }

  remove(key: string): void {
    this.participants.delete(key);
  }
}

let harness: Harness | undefined;
const network = new NetworkInterceptor({ handlers: [mockChatCompletion("Test chat")] });

beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [] });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

it("reports collaborator presence and removes it when the capability closes", async () => {
  if (harness === undefined) throw new Error("Workshop harness did not start");
  const [ownerName, collaboratorName] = nextUsernames("presenceowner", "presencecollaborator");
  if (!ownerName || !collaboratorName) throw new Error("Failed to allocate test usernames");

  using ownerPublic = connect(harness.url);
  using collaboratorPublic = connect(harness.url);
  using owner = await signUp(ownerPublic, ownerName);
  using collaborator = await signUp(collaboratorPublic, collaboratorName);
  using workspace = await owner.newGadget();
  const { id: workspaceId } = await workspace.getMetadata();
  await workspace.newChat("Make this workspace visible without an agent", null);
  await workspace.addCollaborator(collaboratorName, "build");

  const collaboratorWorkspace = await collaborator.openGadget(workspaceId);
  const recorder = new PresenceRecorder();
  using recorderStub = stubFor(recorder);
  using _subscription = await workspace.subscribeToPresence(recorderStub);
  await waitFor("the initial presence roster", async () =>
    recorder.participants.size >= 2 ? true : null);

  expect([...recorder.participants.values()]).toEqual(expect.arrayContaining([
    expect.objectContaining({ user: expect.objectContaining({ id: ownerName }), role: "build" }),
    expect.objectContaining({ user: expect.objectContaining({ id: collaboratorName }), role: "build" }),
  ]));

  collaboratorWorkspace[Symbol.dispose]();
  await waitFor("the disconnected collaborator to leave presence", async () =>
    [...recorder.participants.values()].some(entry => entry.user.id === collaboratorName)
      ? null
      : true);
  await workspace.deleteSelf();
});
