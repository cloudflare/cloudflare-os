import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  ADMIN_ACCESS_ERROR_CODES, getAdminAccessErrorCode,
  type ActionLogEntry, type ActionsSubscriber, type AdminAccessErrorCode, type AdminApi,
  type AdminWriteRecord, type AuthenticatedApi, type Overseer,
} from "@gadgets/workshop-shared/api";
import { loadAllChatHistory } from "../src/agent-session.js";
import { ADMIN_USERNAME, settleRestart, startHarness, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, logIn, nextUsernames, RpcTarget, signUp, streamGeneration, stubFor, waitFor,
  waitForIdleChat,
} from "../src/rpc-client.js";

// A second deployment admin, whom the redeploy that ends this file removes from ADMINS.
const SECOND_ADMIN = "grace";
const REASON = "The owner asked support to clear this up";
const { workspaceNotFound, writesOff } = ADMIN_ACCESS_ERROR_CODES;

type Loose = Record<string, (...args: unknown[]) => Promise<unknown>>;

// The switch is read at startup, the audit log is deployment-wide and the last case redeploys, so
// this file owns its harness, runs serially, and its cases run in order.
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });
const fileScope = new DisposableStack();
let harness: Harness;
let admin: RpcStub<AdminApi>;
let second: RpcStub<AdminApi>;

async function adminApiOf(username: string): Promise<RpcStub<AdminApi>> {
  const api = fileScope.use(await signUp(fileScope.use(connect(harness.url)), username));
  const stub = await api.getAdminApi();
  if (stub === null) throw new Error(`The admin API was unavailable to ${username}`);
  return fileScope.use(stub);
}

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [],
    patchWorkshop: config => {
      config.vars = {
        ...config.vars, ADMINS: [ADMIN_USERNAME, SECOND_ADMIN], ADMIN_WORKSPACE_WRITES: "on",
      };
    },
  });
  admin = await adminApiOf(ADMIN_USERNAME);
  second = await adminApiOf(SECOND_ADMIN);
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

/** The code `call` is refused with; throws if it succeeds. */
async function codeOf(call: PromiseLike<unknown>): Promise<AdminAccessErrorCode | undefined> {
  try {
    await call;
  } catch (error) {
    return getAdminAccessErrorCode(error);
  }
  throw new Error("The call was not refused");
}

/** Every write record the deployment-wide audit log holds of workspace `id`, oldest first, as
 * `api` lists them. */
async function writeRecords(id: string, api: RpcStub<AdminApi> = admin)
    : Promise<AdminWriteRecord[]> {
  const page = await api.listAdminAudit({ kind: "write", workspace: id, limit: 200 });
  return page.records.flatMap(record => record.kind === "write" ? [record] : []).toReversed();
}

type Seeded = {
  owner: RpcStub<AuthenticatedApi>;
  ownerName: string;
  ws: RpcStub<Overseer>;
  id: string;
  title: string;
};

/** A fresh owner's workspace, titled. */
async function seededWorkspace(stack: DisposableStack, prefix: string): Promise<Seeded> {
  const [ownerName] = nextUsernames(prefix);
  const owner = stack.use(await signUp(stack.use(connect(harness.url)), ownerName!));
  const ws = stack.use(await owner.newWorkspace());
  const title = `Workspace of ${ownerName}`;
  await ws.setTitle(title);
  const id = (await ws.getMetadata()).id;
  return { owner, ownerName: ownerName!, ws, id, title };
}

/** A workspace's action log, which an admin's write never enters. */
async function actionLog(ws: RpcStub<Overseer>) {
  return (await ws.listActions()).entries;
}

/** Long enough for a delivery to a subscriber to have arrived, had one been made. */
const settle = () => new Promise(resolve => setTimeout(resolve, 200));

class ActionsRecorder extends RpcTarget implements ActionsSubscriber {
  readonly entries: ActionLogEntry[] = [];
  entry(record: ActionLogEntry): void { this.entries.push(record); }
  ready(): void {}
}

it("refuses writes to a non-admin, whose capabilities run none", async () => {
  using stack = new DisposableStack();
  const { owner, ws, id } = await seededWorkspace(stack, "writesnonadmin");
  const chatId = await ws.newChat("hello", null);
  expect(await owner.getAdminApi()).toBeNull();

  // Not on AuthenticatedApi: reachable only through an AdminApi.
  await expect((owner as unknown as Loose).writeWorkspace!(id, "stopAgent", { chatId }, REASON))
      .rejects.toThrow();

  // The bypass is on the Overseer's Durable Object, never on a capability a user holds. The call
  // is one the workspace would run if the method were reachable.
  const looseWs = ws as unknown as Loose;
  await expect(looseWs.applyAdminWrite!({
    action: "stopAgent", args: { chatId }, reason: REASON, admin: ADMIN_USERNAME,
    sessionId: "session", via: "api",
  })).rejects.toThrow();

  expect(await actionLog(ws)).toEqual([]);
  expect(await writeRecords(id)).toEqual([]);
});

it("runs a write, recorded once in the audit log and nowhere in the workspace", async () => {
  using stack = new DisposableStack();
  const { ws, id, title, ownerName } = await seededWorkspace(stack, "writesowner");
  const chatId = await ws.newChat("hello", null);
  // Subscribed before the write, as a member who has the workspace open is.
  const seen = new ActionsRecorder();
  stack.use(await ws.subscribeToActions(stack.use(stubFor(seen))));

  expect(await admin.writeWorkspace(id, "stopAgent", { chatId }, REASON)).toBeUndefined();

  // The workspace's own record, with the title and owner it gives itself.
  expect(await writeRecords(id)).toEqual([{
    kind: "write", at: expect.any(Date), admin: ADMIN_USERNAME, sessionId: expect.any(String),
    via: "api", workspaceId: id, workspaceOwner: ownerName, workspaceTitle: title,
    method: "stopAgent", args: { chatId }, reason: REASON,
  }]);

  // The workspace's members are shown nothing of it.
  expect(await actionLog(ws)).toEqual([]);
  await settle();
  expect(seen.entries).toEqual([]);

  // Each admin's writes are their own, and are counted.
  await second.writeWorkspace(id, "stopAgent", { chatId }, REASON);
  expect((await writeRecords(id)).map(record => record.admin))
      .toEqual([ADMIN_USERNAME, SECOND_ADMIN]);
  expect(await actionLog(ws)).toEqual([]);
  expect((await admin.getAdminAuditStats({ days: 2, kind: "write" })).writes)
      .toBeGreaterThanOrEqual(2);
});

it("keeps the record of a write the workspace could not run", async () => {
  using stack = new DisposableStack();
  const { ws, id } = await seededWorkspace(stack, "writesfailed");
  await expect(admin.writeWorkspace(id, "stopAgent", { chatId: 999 }, REASON))
      .rejects.toThrow("No such chatId: 999");
  expect((await writeRecords(id)).map(record => record.method)).toEqual(["stopAgent"]);
  expect(await actionLog(ws)).toEqual([]);
});

/** Runs `fn` while the deployment-wide audit log can be read and takes no record. */
async function withAuditLogFaulted<T>(fn: () => Promise<T>): Promise<T> {
  // Addresses the deployment-wide log, which is always getByName("").
  const storage = await harness.server.getWorker("workshop-backend")
      .getDurableObjectStorage("AdminAuditDurableObject", { name: "" });
  try {
    await storage.exec(`CREATE TRIGGER admin_audit_unavailable BEFORE INSERT ON admin_audit
        BEGIN SELECT RAISE(ABORT, 'admin audit unavailable'); END`);
    return await fn();
  } finally {
    await storage.exec("DROP TRIGGER IF EXISTS admin_audit_unavailable");
  }
}

it("changes nothing when the write's record cannot be written", async () => {
  using stack = new DisposableStack();
  const { ws, id } = await seededWorkspace(stack, "writesunaudited");
  const chatId = await ws.newChat("hello", null);

  await withAuditLogFaulted(async () => {
    await expect(admin.writeWorkspace(id, "stopAgent", { chatId }, REASON)).rejects.toThrow();
  });
  // The workspace records before it changes anything, so it changed nothing.
  expect(await actionLog(ws)).toEqual([]);
  expect(await writeRecords(id)).toEqual([]);
});

it("restarts a workspace, ending its sessions, with nothing in its action log", async () => {
  using stack = new DisposableStack();
  const { ws, id, ownerName } = await seededWorkspace(stack, "writesrestart");

  // A restart ends the owner's whole RPC session, so the log is read on another.
  let broken = false;
  ws.onRpcBroken(() => { broken = true; });
  const generation = await streamGeneration(ws);
  await admin.writeWorkspace(id, "restartWorkspace", {}, REASON);
  await waitFor("the owner's session to end", async () => broken || null);
  await expect(ws.listChats()).rejects.toThrow();
  const session = stack.use(await stack.use(
      await logIn(stack.use(connect(harness.url)), ownerName)).openWorkspace(id));
  expect(await streamGeneration(session)).not.toBe(generation);
  expect(await actionLog(session)).toEqual([]);
});

it("stops a turn whose model never answers, keeping the message queued for it", async () => {
  using stack = new DisposableStack();
  const model = models.script([{ pending: true }]);
  const { owner, ws, id } = await seededWorkspace(stack, "writesstopped");
  await owner.addModel(model.userModel.profile, model.userModel.config);

  // A turn whose model never answers, stopped: the chat goes idle, its turn ended as stopped. A
  // message the owner sent meanwhile, which the agent never read, stays in the chat as theirs: no
  // client stopped the turn to put it back in a draft.
  const stuck = await ws.newChat("Never answered", SCRIPTED_MODEL_ID);
  const stuckChat = async () => (await ws.listChats()).find(chat => chat.id === stuck);
  await waitFor("the unanswered model request", async () => model.requests.length === 1 || null);
  expect((await stuckChat())?.activeAgent).toBeDefined();
  await ws.sendChatMessage(stuck, "Also add a streak counter.", SCRIPTED_MODEL_ID);
  await waitFor("the queued message", async () =>
    (await stuckChat())?.queuedSteers?.length === 1 || null);
  await admin.writeWorkspace(id, "stopAgent", { chatId: stuck }, REASON);
  await waitForIdleChat(ws, stuck);
  const stopped = await loadAllChatHistory(before => ws.getChatHistory(stuck, before));
  // Stopped as a member's stop would: the chat does not say who stopped it.
  expect(stopped.at(-1)).toMatchObject(
      { type: "error", code: "stopped", message: "The user stopped the agent." });
  expect(stopped).toContainEqual(expect.objectContaining({
    type: "message", message: "Also add a streak counter.", steered: true,
    author: expect.objectContaining({ type: "user" }),
  }));
  expect((await stuckChat())?.queuedSteers).toBeUndefined();
  expect(await actionLog(ws)).toEqual([]);
});

it("makes no write of an action that is not one of ADMIN_WRITE_ACTIONS", async () => {
  using stack = new DisposableStack();
  const { ws, id } = await seededWorkspace(stack, "writesunlisted");
  // The server's validator throws, and capnweb delivers the throw as a rejection that keeps its
  // TypeError. Deleting a chat and rejecting pending actions are not writes an admin can make.
  for (const action of ["deleteWorkspace", "deleteChat", "rejectPendingActions"]) {
    await expect(admin.writeWorkspace(id, action as never, {}, REASON), action)
        .rejects.toThrow(TypeError);
  }
  expect(await writeRecords(id)).toEqual([]);
  expect((await ws.getMetadata()).id).toBe(id);
});

it("refuses a workspace that is gone, without bringing it back", async () => {
  using stack = new DisposableStack();
  const { ws, id } = await seededWorkspace(stack, "writesgone");
  await ws.deleteSelf();
  await settleRestart();
  // The Overseer keeps its records in typed storage over the KV API, whose table _cf_KV an
  // object's first write creates and deleteAll() drops, so the table is there only if something
  // was written since the deletion. Miniflare's own tables, which any visit creates, are left
  // out, and _cf_KV itself cannot be read, hence sqlite_master.
  const tables = async () => {
    const storage = await harness.server.getWorker("workshop-backend")
        .getDurableObjectStorage("OverseerDurableObject", { id });
    const rows = await storage.exec<{ name: string }>(`SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT GLOB '__miniflare*' ORDER BY name`);
    return rows.map(row => row.name);
  };
  const before = await tables();
  expect(before).not.toContain("_cf_KV");

  expect(await codeOf(admin.writeWorkspace(id, "restartWorkspace", {}, REASON)))
      .toBe(workspaceNotFound);
  expect(await writeRecords(id)).toEqual([]);
  expect(await tables()).toEqual(before);
});

it("refuses every write once a redeploy leaves ADMIN_WORKSPACE_WRITES unset", async () => {
  using stack = new DisposableStack();
  const { id } = await seededWorkspace(stack, "writesoff");

  // The second admin is one no longer, and ADMIN_WORKSPACE_WRITES is left unset.
  await harness.redeployWorkshop(config => {
    config.vars = { ...config.vars, ADMINS: [ADMIN_USERNAME] };
  });

  // The redeploy restarts every Worker, ending every session open at the time.
  const logInAfresh = (username: string) => waitFor(`${username} to log in again`, async () => {
    try {
      return stack.use(await logIn(stack.use(connect(harness.url)), username));
    } catch {
      return null;
    }
  });
  expect(await (await logInAfresh(SECOND_ADMIN)).getAdminApi()).toBeNull();
  const fresh = await (await logInAfresh(ADMIN_USERNAME)).getAdminApi();
  if (fresh === null) throw new Error("The admin API was unavailable after the redeploy");
  stack.use(fresh);

  expect(await codeOf(fresh.writeWorkspace(id, "restartWorkspace", {}, REASON))).toBe(writesOff);
  expect(await writeRecords(id, fresh)).toEqual([]);
});
