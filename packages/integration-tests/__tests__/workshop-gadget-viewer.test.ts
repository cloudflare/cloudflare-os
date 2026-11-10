import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { CollaboratorGrant, GadgetClient, Overseer } from "@gadgets/workshop-shared/api";
import { diffFiles } from "@gadgets/workshop-shared/code-change";
import { type Harness, startHarness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, nextUsernames, RpcTarget, signUp, stubFor, waitFor, WorkpieceRecorder,
} from "../src/rpc-client.js";

let harness: Harness;
const network = new NetworkInterceptor();

beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [], enableGadgetExecution: true });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

type Viewer = { id: string; name: string; role: "owner" | "build" | "use" };

interface ViewerSession extends RpcTarget {
  whoami(): Promise<Viewer | null>;
}

interface ViewerGadget extends RpcTarget {
  startSession(viewer?: Viewer): Promise<ViewerSession>;
  selfViewer(): Promise<Viewer | null>;
}

/** A viewer a caller makes up, which must never reach the gadget. */
const FORGED: Viewer = { id: "forged", name: "Forged", role: "owner" };

const SERVER = `import { DurableObject, RpcTarget } from "cloudflare:workers";
class Session extends RpcTarget {
  #viewer;
  constructor(viewer) { super(); this.#viewer = viewer; }
  whoami() { return this.#viewer; }
}
export class Gadget extends DurableObject {
  startSession(viewer) { return new Session(viewer); }
  selfViewer() { return this.env.GADGET.startSession(${JSON.stringify(FORGED)}).whoami(); }
}`;

/** Who the gadget says is calling on `facet`, after the caller claims to be someone else. */
async function seenBy(facet: RpcStub<ViewerGadget>): Promise<Viewer | null> {
  using session = facet.startSession(FORGED);
  return await session.whoami();
}

it("tells a gadget who each UI connection belongs to", async () => {
  const [owner, builder, user] = nextUsernames("viewerowner", "viewerbuilder", "vieweruser");
  using ownerPublic = connect(harness.url);
  using ownerApi = await signUp(ownerPublic, owner!, "Olive Owner");
  using ws = await ownerApi.newWorkspace();
  const workspaceId = (await ws.getMetadata()).id;
  using gadget = await ws.createGadget("Poll", undefined, "POLL");
  const gadgetId = await gadget.getId();

  const workpieces = new WorkpieceRecorder();
  using workpiecesStub = stubFor(workpieces);
  using _workpieces = await ws.subscribeToWorkpieces(workpiecesStub);
  const head = await waitFor("the new gadget's head", async () => {
    const summary = workpieces.summaries.get(gadgetId);
    return summary?.type === "gadget" ? summary.commitId ?? null : null;
  });
  const chatId = await ws.newChat("Implement the server", null);
  await ws.submitCodeChange(chatId, {
    generation: 0, revision: 0, clientId: "viewer", seq: 1,
    pins: [{ gadgetId, baseCommit: head }],
    change: diffFiles(new Map(), new Map([[gadgetId, new Map([["server.js", SERVER]])]])),
  });
  expect(await ws.mergeChanges(chatId)).toEqual({ outcome: "merged" });

  async function join(username: string, displayName: string, grant: CollaboratorGrant) {
    using stack = new DisposableStack();
    const api = stack.use(await signUp(stack.use(connect(harness.url)), username, displayName));
    if (!await ws.addCollaborator(username, grant)) throw new Error(`Failed to add ${username}`);
    const workspace: RpcStub<Overseer> = stack.use(await api.openWorkspace(workspaceId));
    const joined: RpcStub<GadgetClient> = stack.use(await workspace.getGadget(gadgetId));
    const facet = stack.use(await joined.connectToGadget() as RpcStub<ViewerGadget>);
    return Object.assign(stack.move(), { facet });
  }
  using build = await join(builder!, "Bea Builder", "workspace");
  using use = await join(user!, "Uma User", { gadgetId });
  using facet = await gadget.connectToGadget() as RpcStub<ViewerGadget>;

  // All three are connected to the one shared facet at once.
  expect(await Promise.all([seenBy(facet), seenBy(build.facet), seenBy(use.facet)])).toEqual([
    { id: owner, name: "Olive Owner", role: "owner" },
    { id: builder, name: "Bea Builder", role: "build" },
    { id: user, name: "Uma User", role: "use" },
  ]);

  // The gadget calling itself through its own binding is nobody's UI connection.
  expect(await facet.selfViewer()).toBeNull();
});
