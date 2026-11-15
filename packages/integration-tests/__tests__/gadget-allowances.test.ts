// Trust in a gadget whose code someone else wrote. A gadget made from a blueprint another user
// published asks before each kind of change it makes through the installer's connections, even
// where the installer's own work would go ahead unasked (a workspace rule, an owner default). The
// installer allows it one kind at a time, or everything it can, and can take either back. Their
// own gadgets keep the rules they set.
//
// The gadget's code calls the fixture's `writeValue()`, which submits a `set-value` action through
// the real ApprovalQueue funnel and resolves once it is submitted, decided or not.

import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  ActionLogEntry, AuthenticatedApi, Overseer, WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { openAgentSession } from "../src/agent-session.js";
import { startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, logIn, nextUsernames, signUp, stubFor, waitFor, withOwnerWorkspace,
  WorkpieceRecorder, type ConnectedAccount, type RpcTarget,
} from "../src/rpc-client.js";

const SET_VALUE = { tag: "set-value", label: "Set value" };

const WRITER_SERVER = `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async write(value, autoApprovable) {
    return await this.env.DATA.writeValue(value, { autoApprovable });
  }
}`;

interface WriterGadget extends RpcTarget {
  write(value: number, autoApprovable: boolean): Promise<number>;
}

let harness: Harness;
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness({ enableGadgetExecution: true });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(a => a.vendorId === TEST_VENDOR_ID) ?? null;
  });
}

async function newConnection(ws: RpcStub<Overseer>, accountId: number, resourceUrl: string) {
  using connection = await ws.newGatekeeper(accountId, resourceUrl);
  if (!connection) throw new Error(`Failed to create the connection to ${resourceUrl}`);
  return await connection.getId();
}

async function writes(ws: RpcStub<Overseer>, gadgetId: WorkpieceId) {
  const { entries } = await ws.listActions();
  return entries.filter((a): a is ActionLogEntry & { type: "action" } =>
    a.type === "action" && a.gadgetId === gadgetId).toSorted((a, b) => a.id - b.id);
}

// The drain runs after submit, so "it waits" needs a moment for it not to have happened.
async function settle(ws: RpcStub<Overseer>) {
  await ws.listActions();
  await new Promise(resolve => setTimeout(resolve, 300));
}

const writeOf = async (ws: RpcStub<Overseer>, gadgetId: WorkpieceId, value: number) =>
  (await writes(ws, gadgetId)).find(w => w.description.title === `Set the test value to ${value}`);
const stateOf = async (ws: RpcStub<Overseer>, gadgetId: WorkpieceId, value: number) =>
  (await writeOf(ws, gadgetId, value))?.state;
const applied = (ws: RpcStub<Overseer>, gadgetId: WorkpieceId, value: number) =>
  waitFor(`the write of ${value} to go ahead`, async () => {
    const write = await writeOf(ws, gadgetId, value);
    return write?.state === "approved" ? write : null;
  });

// The publisher builds a gadget that writes through its DATA binding, and publishes it.
async function publishWriter() {
  const model = models.script([
    {
      toolCalls: [
        { id: "create", name: "createGadget", arguments: { title: "Writer", bindingName: "WRITER" } },
        { id: "write", name: "writeFile", arguments: { workpiece: "WRITER", filename: "server.js", content: WRITER_SERVER } },
      ],
    },
    { text: "Built." },
  ]);
  const session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: model.userModel,
    ambientVendorIds: [TEST_VENDOR_ID],
    usernamePrefix: "publisher",
  });
  const built = await session.runTurn("Build the writer.");
  expect(built.outcome).toEqual({ status: "completed" });
  await session.acceptChanges();
  const gadgetId = built.workpieces.find(w => w.title === "Writer")?.id;
  if (gadgetId === undefined) throw new Error("The agent did not create the gadget");
  const accountId = session.connectedAccount(TEST_VENDOR_ID).id;
  const { blueprintId } = await withOwnerWorkspace(harness.url, session.username, async ws => {
    const data = await newConnection(ws, accountId, "https://gadgets-test.example/things/published");
    using gadget = await ws.getGadget(gadgetId);
    await gadget.bind("DATA", data);
    await gadget.setBlueprintAnnotation("DATA", { title: "Data", description: "Where it writes.", suggestValue: false });
    const { id } = await gadget.createBlueprint("Writer", "Writes values");
    return { blueprintId: id };
  });
  return { session, gadgetId, accountId, blueprintId };
}

it("a gadget someone else published asks, until it is allowed, whatever the installer's own rules say", async () => {
  const publisher = await publishWriter();
  await using _publisher = publisher.session;

  const [installer] = nextUsernames("installer");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, installer);
  const account = await provisionAccount(api);
  using ws = await api.newWorkspaceFromBlueprint(publisher.blueprintId, {
    DATA: { type: "gatekeeper", accountId: account.id, resourceUrl: "https://gadgets-test.example/things/installed" },
  });
  const gadgetId = (await ws.getMetadata()).defaultGadgetId;
  if (gadgetId === undefined) throw new Error("The blueprint made no gadget");
  using gadget = await ws.getGadget(gadgetId);
  const data = (await gadget.listBindings()).find(b => b.name === "DATA")?.target;
  if (data === undefined) throw new Error("The gadget has no DATA binding");

  const recorder = new WorkpieceRecorder();
  using recorderStub = stubFor(recorder);
  using _workpieces = await ws.subscribeToWorkpieces(recorderStub);
  await recorder.loaded;
  const summary = () => {
    const found = recorder.summaries.get(gadgetId);
    if (found?.type !== "gadget") throw new Error("No summary for the gadget");
    return found;
  };
  expect(summary().publishedBy?.id).toBe(publisher.session.username);

  // Everything the installer's own work would go ahead with.
  await api.setDefaultAutoApprovedActionKind(TEST_VENDOR_ID, SET_VALUE);
  await ws.setAutoApprovedActionKind(data, SET_VALUE);

  using facet = await gadget.connectToGadget() as RpcStub<WriterGadget>;
  await facet.write(1, true);
  await settle(ws);
  expect(await stateOf(ws, gadgetId, 1)).toBe("pending");

  // The Library says it waits on them.
  const workspaceId = (await ws.getMetadata()).id;
  const waitingFor = async () => (await api.listOutputs()).outputs
    .find(o => o.workspaceId === workspaceId && o.workpieceId === gadgetId)?.waiting;
  await waitFor("the Library to say it waits", async () => (await waitingFor()) === 1 || null);

  // Allowing the kind lets the waiting write through, and the next ones.
  await gadget.allowActionKind(data, SET_VALUE);
  expect(await applied(ws, gadgetId, 1)).toMatchObject({ autoApproved: true, resolvedBy: { id: installer } });
  await waitFor("the allowance to show", async () => summary().allowed?.[0]?.actionKind.tag === SET_VALUE.tag || null);
  await facet.write(2, true);
  await applied(ws, gadgetId, 2);
  await waitFor("the Library to stop saying it waits", async () => (await waitingFor()) === undefined || null);

  // What its service never lets through unasked still asks.
  await facet.write(3, false);
  await settle(ws);
  const unaskable = await writeOf(ws, gadgetId, 3);
  expect(unaskable?.state).toBe("pending");
  await ws.rejectAction(unaskable!.id);

  // Taken back, it asks again; everything it can goes ahead again in Auto.
  await gadget.disallowActionKind(data, SET_VALUE.tag);
  await facet.write(4, true);
  await settle(ws);
  expect(await stateOf(ws, gadgetId, 4)).toBe("pending");
  await gadget.setAutoApprove(true);
  await applied(ws, gadgetId, 4);
});

it("a gadget of the owner's own goes ahead by the owner's rules", async () => {
  const publisher = await publishWriter();
  await using session = publisher.session;
  await withOwnerWorkspace(harness.url, session.username, async ws => {
    using gadget = await ws.getGadget(publisher.gadgetId);
    const data = (await gadget.listBindings()).find(b => b.name === "DATA")?.target;
    if (data === undefined) throw new Error("The gadget has no DATA binding");
    await ws.setAutoApprovedActionKind(data, SET_VALUE);
    using facet = await gadget.connectToGadget() as RpcStub<WriterGadget>;
    await facet.write(1, true);
    expect(await applied(ws, publisher.gadgetId, 1)).toMatchObject({ autoApproved: true });
  });
});

it("a blueprint the owner published from their own gadget is theirs; one uploaded from a file is not", async () => {
  const publisher = await publishWriter();
  await using session = publisher.session;
  using publicApi = connect(harness.url);
  using api = await logIn(publicApi, session.username);
  const bindings = {
    DATA: { type: "gatekeeper" as const, accountId: publisher.accountId, resourceUrl: "https://gadgets-test.example/things/again" },
  };
  const publishedBy = async (blueprintId: string) => {
    using ws = await api.newWorkspaceFromBlueprint(blueprintId, bindings);
    const gadgetId = (await ws.getMetadata()).defaultGadgetId;
    const recorder = new WorkpieceRecorder();
    using recorderStub = stubFor(recorder);
    using _workpieces = await ws.subscribeToWorkpieces(recorderStub);
    await recorder.loaded;
    const summary = gadgetId === undefined ? undefined : recorder.summaries.get(gadgetId);
    return summary?.type === "gadget" ? summary.publishedBy : "no gadget";
  };
  expect(await publishedBy(publisher.blueprintId)).toBeUndefined();
  const uploaded = await api.importBlueprint(await publicApi.downloadBlueprint(publisher.blueprintId));
  expect(await publishedBy(uploaded)).toMatchObject({ id: session.username });
});
