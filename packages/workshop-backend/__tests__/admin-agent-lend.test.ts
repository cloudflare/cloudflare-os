// How a workspace lends its owner's Admin API to the admin gatekeeper (OverseerImpl.lendAdminApi(),
// the queue openGatekeeperSession() gives its sessions, and the one call an approved action is
// lent): over a real OverseerDurableObject and a fixture facet that stands for the gatekeeper, a
// Worker that keeps everything it is given (FakeAdminGatekeeper in test-worker.ts).
//
// The workspace inspects itself where a test needs a view: the Admin API reaches it through its
// own Durable Object stub, as it reaches any workspace, so the view is the native stub a real
// lend returns. The audit log is the real object behind ctx.exports.
//
// Time is moved with a spy on Date.now(): a session's deadline is fixed by its queue when the
// queue is made, and neither the queue nor the lend takes a clock from outside.
//
// A content access request an action files goes to the deployment's own AdminSettings object, and
// the workspace's listing is read from its own user directory (see withWrites()). A write an
// action runs is the workspace's on itself.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_GRANT_ERROR_CODES, getAdminGrantErrorCode,
  type AdminAccessRecord, type AdminAuditRecord, type AdminContentRequest, type AdminGrantRecord,
  type AdminWriteRecord, type AiChatAuthorInfo,
} from "@gadgets/workshop-shared/api";
import {
  ADMIN_AGENT_ACTIONS, ADMIN_AGENT_LEND_SECONDS, type AdminAgentAction,
} from "@gadgets/workshop-shared/admin-agent";
import { AdminApiImpl, type AdminSettings } from "../src/admin-settings.js";
import type { AdminSettingsStorage } from "../src/storage-schema/admin-settings-storage.js";
import type { GatekeeperCaller } from "../src/storage-schema/overseer-storage.js";
import type { UserDurableObject } from "../src/user.js";
import type { UserDirectoryDurableObject } from "../src/user-directory.js";
import type { FakeAdminVendor } from "./test-worker.js";
import {
  ADMIN, NOT_ADMIN, OTHER_ADMIN, adminWorkspace, type AdminWorkspace,
} from "./admin-agent-helpers.js";
// Load the whole backend (the pool's `main`) up front, so its slow load does not count against the
// first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    GATEKEEPER_ADMIN: Service<FakeAdminVendor>;
    TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
    TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>;
  }
}

const REASON = "Looking into an issue report";
const LEND_MS = ADMIN_AGENT_LEND_SECONDS * 1000;
const ENDED = "This Admin API session has ended. Open a new one.";
// What createAdminAccessError(notAdmin) says, as it arrives over RPC.
const NOT_ADMIN_MESSAGE =
    "Only a deployment admin can inspect a workspace or a user, or change a workspace.";
// What a connection is told once its workspace's owner holds no account of the admin gatekeeper.
const ACCOUNT_REMOVED = "This workspace's owner has removed the deployment admin account, so " +
    "this connection reaches nothing. Add the account again from Connectors, or remove the " +
    "connection.";
const AGENT: GatekeeperCaller = { from: "agent", chatId: 5 };
const OPEN = (ws: AdminWorkspace, options?: object) =>
    ({ method: "inspectWorkspace", args: options ? [ws.id, REASON, options] : [ws.id, REASON] });

afterEach(() => { vi.restoreAllMocks(); });

// An action of `kind` as the gatekeeper would queue it, with `claims` over its description.
function describeAction(kind: AdminAgentAction, claims: object = {}) {
  return {
    title: ADMIN_AGENT_ACTIONS[kind].kind.label, description: "What will be posted or set.",
    implementsRevert: false, autoApprovable: ADMIN_AGENT_ACTIONS[kind].autoApprovable,
    actionKind: ADMIN_AGENT_ACTIONS[kind].kind, ...claims,
  };
}

// Queues action number `action` of `kind` through a session of `caller`, planned to make `calls`,
// and returns its record's id.
async function queueAction(ws: AdminWorkspace, action: number, kind: AdminAgentAction,
    calls: { method: string; args?: unknown[] }[], options: { caller?: GatekeeperCaller;
    claims?: object } = {}): Promise<number> {
  await ws.facet.plan(action, calls);
  using session = await ws.session(options.caller ?? AGENT);
  await session.submit(action, describeAction(kind, options.claims));
  let records = [...ws.impl.storage.actions.list()]
      .filter((record: any) => record.type === "action" && record.action === action);
  return records.at(-1).id;
}

const stateOf = (ws: AdminWorkspace, id: number) => ws.impl.storage.actions.get(id).state;

// Why a session of `caller` is refused queueing action `action`, which is then not stored.
async function refusedSubmit(ws: AdminWorkspace, action: number, kind: AdminAgentAction,
    caller: GatekeeperCaller = AGENT): Promise<string | undefined> {
  let before = [...ws.impl.storage.actions.list()].length;
  using session = await ws.session(caller);
  let refusal = await session.submit(action, describeAction(kind))
      .then(() => undefined, (error: Error) => error.message);
  expect([...ws.impl.storage.actions.list()]).toHaveLength(before);
  return refusal;
}

// Approves action `id` as `by` does from the Workshop, returning the refusal if it fails.
async function approve(ws: AdminWorkspace, id: number, by: AiChatAuthorInfo = ADMIN)
    : Promise<string | undefined> {
  try {
    await ws.impl.applyPendingAction(ws.impl.storage.actions.get(id), by, false);
  } catch (error) {
    return (error as Error).message;
  }
}

// Turns on the rule that auto-approves `kind` on the admin connection, enabled by `by`.
function enableRule(ws: AdminWorkspace, kind: AdminAgentAction, by: AiChatAuthorInfo = ADMIN) {
  ws.impl.storage.autoApproveTags.put(
      { gatekeeperId: ws.gatekeeperId, actionKind: ADMIN_AGENT_ACTIONS[kind].kind, enabledBy: by });
}

describe("a session of the admin gatekeeper", () => {
  it("reads through the lent Admin API", () => adminWorkspace(async ws => {
    using session = await ws.session(AGENT);
    expect(await session.read({ method: "listUsers" })).toEqual({ value: { users: [] } });
    expect((await session.read({ method: "getSettings" })).error).toBeUndefined();
  }));

  it("is refused every act and omitted method", () => adminWorkspace(async ws => {
    using session = await ws.session(AGENT);
    expect(await session.read(
        { method: "writeWorkspace", args: [ws.id, "restartWorkspace", {}, REASON] }))
        .toEqual({ error: "AdminApi.writeWorkspace() runs only as an approved action." });
    expect(await session.read({ method: "requestContentAccess", args: [ws.id, REASON] }))
        .toEqual({ error: "AdminApi.requestContentAccess() runs only as an approved action." });
    expect(await session.read({ method: "setSiteName", args: ["x"] }))
        .toEqual({ error: "AdminApi.setSiteName() is not available through the admin gatekeeper." });
    expect(await ws.records()).toEqual([]);
  }));

  it.each<[string, GatekeeperCaller]>([
    ["an agent's", AGENT],
    ["a gadget's", { from: "gadget", gadgetId: 1 }],
    ["the owner's direct", { from: "user" }],
  ])("stops %s session at its deadline, the stub it was lent included", (_label, caller) =>
      adminWorkspace(async ws => {
    let made = Date.now();
    using session = await ws.session(caller);
    expect((await session.read({ method: "listUsers" }, { api: "api" })).error).toBeUndefined();

    // A moment before the deadline the queue still lends, and what it lent still answers.
    let clock = vi.spyOn(Date, "now").mockReturnValue(made + LEND_MS - 1);
    expect((await session.read({ method: "listUsers" })).error).toBeUndefined();
    expect((await ws.facet.onKept("api", { method: "listUsers" })).error).toBeUndefined();

    // Asking again does not extend it: the deadline was fixed when the queue was made.
    clock.mockReturnValue(made + LEND_MS + 1000);
    expect(await session.read({ method: "listUsers" })).toEqual({ error: ENDED });
    expect(await ws.facet.onKept("api", { method: "listUsers" })).toEqual({ error: ENDED });
    // Nor does it queue an action once past it.
    let refusal = await session.submit(1, describeAction("workspaceWriteRequest"))
        .then(() => undefined, (error: Error) => error.message);
    expect(refusal).toBe(ENDED);
    expect([...ws.impl.storage.actions.list()]).toEqual([]);
  }));

  it("stops a view with the session that opened it", () => adminWorkspace(async ws => {
    let session = await ws.session(AGENT);
    expect(await session.read(OPEN(ws), { result: "view" })).toEqual({ kept: "view" });
    expect((await ws.facet.onKept("view", { method: "listChats" })).error).toBeUndefined();

    session[Symbol.dispose]();
    await vi.waitFor(async () => {
      expect(await ws.facet.onKept("view", { method: "listChats" })).toEqual({ error: ENDED });
    });
  }));

  it("leaves a Worker that keeps a view nothing once its session is over",
      () => adminWorkspace(async ws => {
    let before = Date.now();
    let session = await ws.session(AGENT);
    let deadline = Date.now() + LEND_MS;
    expect(before + LEND_MS).toBeLessThanOrEqual(deadline);

    // The Worker asks for the longest life a view can have, and keeps the lent API too.
    expect(await session.read(OPEN(ws, { lifetimeSeconds: 3600 }), { api: "api", result: "view" }))
        .toEqual({ kept: "view" });

    // dup() on the stub it was returned is answered by the Worker's own stub and never reaches
    // the Workshop: it is a second stub of the membrane, not of the view.
    expect(await ws.facet.onKept("view", { method: "dup" }, "copy")).toEqual({ kept: "copy" });
    // dup() pipelined on the promise of the open is refused by workerd itself, which reserves
    // the name; the open it rode on still ran, and nothing was kept of it.
    let pipelined = await session.read(OPEN(ws), { result: "pipelined" }, { method: "dup" });
    expect(pipelined.error).toMatch(/'dup' is a reserved method/);
    // onRpcBroken() is sent to the Workshop, where the membrane refuses it.
    expect(await ws.facet.onKept("view", { method: "onRpcBroken" }))
        .toEqual({ error: "This view has no method onRpcBroken." });
    // So is the open itself, which the view's own table names but the membrane's does not.
    expect(await ws.facet.onKept("view", { method: "inspectWorkspace", args: [ws.id, REASON] }))
        .toEqual({ error: "This view has no method inspectWorkspace." });
    expect(await ws.facet.kept()).toEqual(["api", "view", "copy"]);

    // The view's life is the session's, whatever was asked for.
    let description = await ws.facet.onKept("copy", { method: "describe" });
    let expiresAt = (description.value as { expiresAt: Date }).expiresAt.getTime();
    expect(expiresAt).toBeLessThanOrEqual(deadline + 1000);
    expect(expiresAt).toBeGreaterThan(before + LEND_MS - 60_000);
    let opens = (await ws.records()).filter(record => record.method === "inspectWorkspace");
    expect(opens.map(record => record.args)).toEqual([
      { expiresAt: new Date(expiresAt).toISOString() }, { expiresAt: expect.any(String) },
    ]);
    expect(Date.parse((opens[1]!.args as { expiresAt: string }).expiresAt))
        .toBeLessThanOrEqual(deadline + 1000);

    session[Symbol.dispose]();
    await vi.waitFor(async () => {
      expect(await ws.facet.onKept("view", { method: "describe" })).toEqual({ error: ENDED });
    });
    let recorded = (await ws.records()).length;
    for (let name of ["view", "copy"]) {
      expect(await ws.facet.onKept(name, { method: "describe" })).toEqual({ error: ENDED });
    }
    expect(await ws.facet.onKept("api", { method: "listUsers" })).toEqual({ error: ENDED });
    expect(await ws.facet.onKept("api", OPEN(ws), "late")).toEqual({ error: ENDED });
    expect(await ws.records()).toHaveLength(recorded);
  }));

  it("refuses the next call once the deployment turns the gatekeeper off",
      () => adminWorkspace(async ws => {
    using session = await ws.session(AGENT);
    expect((await session.read({ method: "listUsers" }, { api: "api" })).error).toBeUndefined();
    expect(await session.read(OPEN(ws), { result: "view" })).toEqual({ kept: "view" });

    ws.config.ambientGatekeeperModes.admin = "disabled";
    let off = { error: "Gatekeeper is disabled." };
    expect(await ws.facet.onKept("api", { method: "listUsers" })).toEqual(off);
    expect(await ws.facet.onKept("view", { method: "describe" })).toEqual(off);
    expect(await session.read({ method: "listUsers" })).toEqual(off);

    ws.config.ambientGatekeeperModes.admin = "optional";
    ws.config.disabledGatekeepers = ["admin"];
    expect(await ws.facet.onKept("api", { method: "listUsers" })).toEqual(off);
    expect(await session.read({ method: "listUsers" })).toEqual(off);

    ws.config.disabledGatekeepers = [];
    expect((await ws.facet.onKept("api", { method: "listUsers" })).error).toBeUndefined();
  }));

  it("refuses the next call once the owner is no longer an admin", () => adminWorkspace(async ws => {
    using session = await ws.session(AGENT);
    expect((await session.read({ method: "listUsers" }, { api: "api" })).error).toBeUndefined();
    ws.env.ADMINS = [OTHER_ADMIN.id];
    expect(await ws.facet.onKept("api", { method: "listUsers" }))
        .toEqual({ error: NOT_ADMIN_MESSAGE });
    expect(await session.read({ method: "listUsers" })).toEqual({ error: NOT_ADMIN_MESSAGE });
  }));
});

// The origin of the open a session of `caller` makes, as the audit log keeps it.
async function originOf(ws: AdminWorkspace, caller: GatekeeperCaller)
    : Promise<Pick<AdminAccessRecord, "admin" | "via" | "agent">> {
  using session = await ws.session(caller);
  expect(await session.read(OPEN(ws), { result: "view" })).toEqual({ kept: "view" });
  expect((await ws.facet.onKept("view", { method: "describe" })).error).toBeUndefined();
  let records = await ws.records();
  expect(records.map(record => record.method)).toEqual(["inspectWorkspace", "describe"]);
  // The view's calls carry what its open does.
  expect(records[1]).toMatchObject(
      { admin: records[0]!.admin, via: records[0]!.via, agent: records[0]!.agent });
  let { admin, via, agent } = records[0]!;
  return { admin, via, agent };
}

describe("what a lent call records", () => {
  it.each<[string, GatekeeperCaller, number | undefined]>([
    ["an agent's chat", { from: "agent", chatId: 5 }, 5],
    ["the chat whose changes a gadget runs", { from: "gadget", gadgetId: 1, chatId: 8 }, 8],
    ["no chat for a gadget's merged code", { from: "gadget", gadgetId: 1 }, undefined],
    ["no chat for a hook's firing", { from: "hook", gadgetId: 1 }, undefined],
    ["no chat for the owner's direct session", { from: "user" }, undefined],
  ])("names the owner, the workspace and %s", (_label, caller, chatId) =>
      adminWorkspace(async ws => {
    expect(await originOf(ws, caller)).toEqual({
      admin: ADMIN.id, via: "gatekeeper",
      agent: chatId === undefined ? { workspaceId: ws.id } : { workspaceId: ws.id, chatId },
    });
  }));

  it("opens a view of a user's account, which answers its own methods alone and records " +
      "each call with where it came from", () => adminWorkspace(async ws => {
    let userId = `lent${crypto.randomUUID().replaceAll("-", "")}`;
    await runInDurableObject(env.TEST_USER.getByName(userId), async (account: UserDurableObject) => {
      // The account reads the deployment's settings as the workspace does.
      Object.assign(account, { env: ws.env });
      expect(await account.createAccount(userId, "Viewed User", new Uint8Array([1, 2, 3])))
          .not.toBeNull();
    });

    using session = await ws.session(AGENT);
    expect(await session.read({ method: "inspectUser", args: [userId, REASON] }, { result: "view" }))
        .toEqual({ kept: "view" });
    let described = await ws.facet.onKept("view", { method: "describe" });
    expect(described.value).toMatchObject({ profile: { id: userId } });
    // Nothing of a workspace's view, and not the open.
    for (let method of ["getChat", "readFile", "inspectUser"]) {
      expect(await ws.facet.onKept("view", { method, args: [1] }))
          .toEqual({ error: `This view has no method ${method}.` });
    }

    let page = await env.TEST_ADMIN_AUDIT.getByName("").list({ owner: userId, limit: 10 }, 90);
    let origin = { admin: ADMIN.id, via: "gatekeeper", agent: { workspaceId: ws.id, chatId: 5 } };
    expect(page.records.toReversed()).toMatchObject([
      { kind: "user", userId, method: "inspectUser", access: "metadata", ...origin },
      { kind: "user", userId, method: "describe", access: "metadata", ...origin },
    ]);
    // The workspace that lent the call holds no record of it: the account is not a workspace.
    expect(await ws.records()).toEqual([]);
  }));

  it("takes no origin from the gatekeeper: an argument that claims one is the API's to refuse",
      () => adminWorkspace(async ws => {
    using session = await ws.session(AGENT);
    let claimed = { via: "api", agent: { workspaceId: "elsewhere", chatId: 99 } };
    let outcome = await session.read(
        { method: "inspectWorkspace", args: [ws.id, REASON, claimed, claimed] }, { result: "view" });
    // Whether AdminApi ignores or refuses the stray fields, no record carries them.
    for (let record of await ws.records()) {
      expect(record).toMatchObject(
          { via: "gatekeeper", agent: { workspaceId: ws.id, chatId: 5 }, admin: ADMIN.id });
    }
    expect(outcome.error === undefined || !/elsewhere/.test(outcome.error)).toBe(true);
  }));
});

describe("an approved action of the admin gatekeeper", () => {
  it("makes its one call, recorded with the chat that queued it", () => adminWorkspace(ws =>
      withWrites(ws, async () => {
    let restart = { method: "writeWorkspace", args: [ws.id, "restartWorkspace", {}, REASON] };
    let id = await queueAction(ws, 1, "workspaceWriteRequest", [restart, restart]);
    expect(stateOf(ws, id)).toBe("pending");
    expect(await recordsOf(ws, "write")).toEqual([]);

    expect(await approve(ws, id, OTHER_ADMIN)).toBeUndefined();
    expect(ws.impl.storage.actions.get(id)).toMatchObject(
        { state: "approved", autoApproved: false, resolvedBy: OTHER_ADMIN });
    // The write is the owner's, made through the gatekeeper from the chat that queued it.
    expect(await recordsOf(ws, "write")).toMatchObject([{
      admin: ADMIN.id, via: "gatekeeper", agent: { workspaceId: ws.id, chatId: 5 },
    }]);

    // A second call inside the apply was refused, and so is the copy of the lend the Worker kept.
    let outcomes = await ws.facet.outcomes(1);
    expect(outcomes![0]!.error).toBeUndefined();
    expect(outcomes![1]).toEqual({ error: "This action has made its one call." });
    expect(await ws.facet.onKept("action:1", restart))
        .toEqual({ error: "This action has made its one call." });
    expect(await recordsOf(ws, "write")).toHaveLength(1);
  })));

  it("ends a lend whose call was never made when the apply returns",
      () => adminWorkspace(async ws => {
    let id = await queueAction(ws, 2, "workspaceWriteRequest", []);
    expect(await approve(ws, id)).toBeUndefined();
    expect(await ws.facet.onKept("action:2",
        { method: "writeWorkspace", args: [ws.id, "restartWorkspace", {}, REASON] }))
        .toEqual({ error: ENDED });
    expect(await ws.records()).toEqual([]);
  }));

  it("cannot file a request for content as a write", () => adminWorkspace(async ws => {
    let id = await queueAction(ws, 4, "workspaceWriteRequest",
        [{ method: "requestContentAccess", args: [ws.id, REASON] }]);
    expect(await approve(ws, id))
        .toBe("This action may only call AdminApi.writeWorkspace().");
    expect(stateOf(ws, id)).toBe("pending");
    expect(await ws.records()).toEqual([]);
  }));

  it.each<AdminAgentAction>(["contentAccessRequest", "workspaceWriteRequest"])(
      "is never applied by a rule when its kind is %s, whatever its description claims",
      kind => adminWorkspace(async ws => {
    enableRule(ws, kind);
    let call = kind === "contentAccessRequest"
        ? { method: "requestContentAccess", args: [ws.id, REASON] }
        : { method: "writeWorkspace", args: [ws.id, "restartWorkspace", {}, REASON] };
    let id = await queueAction(ws, 5, kind, [call], { claims: { autoApprovable: true } });
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);

    expect(stateOf(ws, id)).toBe("pending");
    // The lend refused before the facet was called.
    expect(await ws.facet.outcomes(5)).toBeUndefined();
    expect(await ws.records()).toEqual([]);
    await expect(ws.impl.lendAdminApi(ws.gatekeeperId, AGENT,
        { for: "action", kind, autoApproved: true, decidedBy: ADMIN.id }))
        .rejects.toThrow("This kind of action is never auto-approved.");
  }));

  it("refuses an action whose tag is not one of the gatekeeper's", () => adminWorkspace(async ws => {
    let id = await queueAction(ws, 6, "workspaceWriteRequest",
        [{ method: "writeWorkspace", args: [ws.id, "restartWorkspace", {}, REASON] }],
        { claims: { actionKind: { tag: "post-anything", label: "Post anything" } } });
    expect(await approve(ws, id)).toBe("This is not an action of the admin gatekeeper.");
    expect(stateOf(ws, id)).toBe("pending");
    expect(await ws.facet.outcomes(6)).toBeUndefined();
    expect(await ws.records()).toEqual([]);
  }));
});

describe("who is lent the Admin API", () => {
  it("lends nothing in a workspace whose owner is not an admin", () => adminWorkspace(async ws => {
    using session = await ws.session(AGENT);
    expect(await session.read({ method: "listUsers" }, { api: "api" }))
        .toEqual({ error: NOT_ADMIN_MESSAGE });
    expect(await ws.facet.kept()).toEqual([]);

    // Nor is anything queued, which a person could approve once the owner is an admin again.
    expect(await refusedSubmit(ws, 1, "workspaceWriteRequest")).toBe(NOT_ADMIN_MESSAGE);
    expect(await ws.facet.outcomes(1)).toBeUndefined();
  }, { owner: NOT_ADMIN }));

  it("lends nothing, and queues nothing, while the vendor's mode is disabled",
      () => adminWorkspace(async ws => {
    // Queued before the vendor was turned off: it waits, and is not applied meanwhile.
    let id = await queueAction(ws, 1, "workspaceWriteRequest", []);
    ws.config.ambientGatekeeperModes.admin = "disabled";
    using session = await ws.session(AGENT);
    expect(await session.read({ method: "listUsers" }))
        .toEqual({ error: "Gatekeeper is disabled." });
    expect(await approve(ws, id)).toBe("Gatekeeper is disabled.");
    expect(stateOf(ws, id)).toBe("pending");
    expect(await refusedSubmit(ws, 2, "workspaceWriteRequest")).toBe("Gatekeeper is disabled.");

    ws.config.ambientGatekeeperModes.admin = "enabled";
    expect((await session.read({ method: "listUsers" })).error).toBeUndefined();
  }));

  it("lends nothing to a session another admin opened from the connection itself",
      () => adminWorkspace(async ws => {
    // A "build" collaborator who is a deployment admin, as getGatekeeperById().openSession()
    // opens a session for one: a holder, and a caller with no chat.
    using theirs = await ws.session({ from: "user" }, { kind: "build", profileId: OTHER_ADMIN.id });
    let outcome = await theirs.read(OPEN(ws), { api: "api", result: "view" });
    expect(outcome.error).toMatch(/^Only this workspace's owner can open the admin connection/);
    expect(await ws.facet.kept()).toEqual([]);
    expect(await ws.records()).toEqual([]);

    // The owner's own direct session is lent to, and recorded with no chat.
    using own = await ws.session({ from: "user" });
    expect(await own.read(OPEN(ws), { result: "view" })).toEqual({ kept: "view" });
    expect(await ws.records()).toMatchObject(
        [{ method: "inspectWorkspace", admin: ADMIN.id, agent: { workspaceId: ws.id } }]);
    expect((await ws.records())[0]!.agent).toEqual({ workspaceId: ws.id });

    // From a chat, the same collaborator's call is the chat's: the chat keeps who prompted it.
    using chat = await ws.session(AGENT, { kind: "build", profileId: OTHER_ADMIN.id });
    expect((await chat.read({ method: "listUsers" })).error).toBeUndefined();
  }));

  it("queues nothing for a session another admin opened from the connection itself",
      () => adminWorkspace(async ws => {
    // A person approving it would make the owner's write, recorded with nobody behind it.
    await ws.facet.plan(1, []);
    using theirs = await ws.session({ from: "user" }, { kind: "build", profileId: OTHER_ADMIN.id });
    let refusal = await theirs.submit(1, describeAction("workspaceWriteRequest"))
        .then(() => undefined, (error: Error) => error.message);
    expect(refusal).toMatch(/^Only this workspace's owner can open the admin connection/);
    expect([...ws.impl.storage.actions.list()]).toEqual([]);

    // The owner's own direct session queues.
    using own = await ws.session({ from: "user" });
    await own.submit(1, describeAction("workspaceWriteRequest"));
    expect([...ws.impl.storage.actions.list()]).toHaveLength(1);

    // From a chat, the same collaborator's action is the chat's.
    using chat = await ws.session(AGENT, { kind: "build", profileId: OTHER_ADMIN.id });
    await chat.submit(2, describeAction("workspaceWriteRequest"));
    expect([...ws.impl.storage.actions.list()]).toHaveLength(2);
  }));

  it("queues nothing once the user stopped the turn its session belongs to",
      () => adminWorkspace(async ws => {
    vi.spyOn(ws.impl, "isLiveExecution").mockReturnValue(true);
    let stopped = vi.spyOn(ws.impl, "isStoppedExecution").mockReturnValue(false);
    using session = await ws.impl.openGatekeeperSession(ws.gatekeeperId,
        await ws.impl.getGatekeeperFacet(ws.gatekeeperId), AGENT, "execution-1");

    stopped.mockReturnValue(true);
    let refusal = await session.submit(1, describeAction("workspaceWriteRequest"))
        .then(() => undefined, (error: Error) => error.message);
    expect(refusal).toBe("The user stopped the agent turn this session belongs to.");
    expect([...ws.impl.storage.actions.list()]).toEqual([]);
  }));

  it("queues nothing for a turn stopped while the connection's owner is looked up",
      () => adminWorkspace(async ws => {
    vi.spyOn(ws.impl, "isLiveExecution").mockReturnValue(true);
    let stopped = vi.spyOn(ws.impl, "isStoppedExecution").mockReturnValue(false);
    using session = await ws.impl.openGatekeeperSession(ws.gatekeeperId,
        await ws.impl.getGatekeeperFacet(ws.gatekeeperId), AGENT, "execution-1");
    let lookup = ws.impl.adminConnectionOwner.bind(ws.impl);
    vi.spyOn(ws.impl, "adminConnectionOwner").mockImplementation(async (id: number) => {
      let owner = await lookup(id);
      stopped.mockReturnValue(true);
      return owner;
    });

    let refusal = await session.submit(1, describeAction("workspaceWriteRequest"))
        .then(() => undefined, (error: Error) => error.message);
    expect(refusal).toBe("The user stopped the agent turn this session belongs to.");
    expect([...ws.impl.storage.actions.list()]).toEqual([]);
  }));

  it("refuses an action a member who is not an admin approved", () => adminWorkspace(ws =>
      withWrites(ws, async () => {
    let id = await queueAction(ws, 1, "workspaceWriteRequest",
        [{ method: "writeWorkspace", args: [ws.id, "restartWorkspace", {}, REASON] }]);
    expect(await approve(ws, id, NOT_ADMIN)).toBe(NOT_ADMIN_MESSAGE);
    expect(stateOf(ws, id)).toBe("pending");
    expect(await ws.facet.outcomes(1)).toBeUndefined();

    // A member who was demoted is refused as one who never was an admin.
    ws.env.ADMINS = [ADMIN.id];
    expect(await approve(ws, id, OTHER_ADMIN)).toBe(NOT_ADMIN_MESSAGE);
    expect(await approve(ws, id, ADMIN)).toBeUndefined();
    expect(await recordsOf(ws, "write")).toHaveLength(1);
  })));

  it("gives a connection of another vendor a plain queue and no lend",
      () => adminWorkspace(async ws => {
    let client = await ws.impl.addGatekeeper(
        ws.impl.ctx.exports.FakeAdminGatekeeper({ props: {} }),
        { type: "gatekeeper", vendorId: "othervendor", resourceUrl: "https://other.example/",
          typeUrlPattern: "https://other.example/" }, "owner-user-do");
    let otherId: number = await client.getId();
    let facet = await ws.impl.getGatekeeperFacet(otherId);

    using session = await ws.impl.openGatekeeperSession(otherId, facet, AGENT);
    let outcome = await session.read({ method: "listUsers" }, { api: "api" });
    expect(outcome.error).toMatch(/getAdminApi/);
    expect(await facet.kept()).toEqual([]);
    await expect(ws.impl.lendAdminApi(otherId, AGENT,
        { for: "session", until: Date.now() + 60_000, live: () => {} }))
        .rejects.toThrow("This connection is not the admin gatekeeper's.");

    // Its actions are applied as any gatekeeper's are, with nothing lent.
    await session.submit(1, describeAction("workspaceWriteRequest"));
    let [record] = [...ws.impl.storage.actions.list()]
        .filter((action: any) => action.gatekeeperId === otherId);
    expect(await approve(ws, record.id))
        .toBe("applyAction() was called on the admin gatekeeper.");
    expect(await facet.outcomes(1)).toBeUndefined();
  }));

  it("lends nothing once the connection is gone", () => adminWorkspace(async ws => {
    await expect(ws.impl.lendAdminApi(7, AGENT,
        { for: "session", until: Date.now() + 60_000, live: () => {} }))
        .rejects.toThrow("This connection is not the admin gatekeeper's.");
  }, { connection: false }));

});

// The ids of the accounts of the admin gatekeeper in the owner's storage, offered or not.
function ownerAccounts(ws: AdminWorkspace): Promise<number[]> {
  return runInDurableObject(ws.ownerDo, user => {
    let { storage } = user as unknown as { storage: {
      nextAccountId: { get(): number };
      connectedAccounts: { get(id: number): { vendorId: string } | undefined };
    } };
    let ids: number[] = [];
    for (let id = 0; id < storage.nextAccountId.get(); id++) {
      if (storage.connectedAccounts.get(id)?.vendorId === "admin") ids.push(id);
    }
    return ids;
  });
}

describe("the owner's account of the admin gatekeeper", () => {
  it("ends its connections when it is removed, and brings them back when it is added again",
      () => adminWorkspace(async ws => {
    let id = await queueAction(ws, 1, "workspaceWriteRequest", []);
    expect(stateOf(ws, id)).toBe("pending");
    using session = await ws.session(AGENT);
    expect((await session.read({ method: "listUsers" }, { api: "before" })).error).toBeUndefined();

    let [accountId] = await ownerAccounts(ws);
    await ws.ownerDo.disconnectAccount(accountId!);
    expect(await ownerAccounts(ws)).toEqual([]);

    // Nothing more is lent: to a session or to an approved action.
    expect(await session.read(OPEN(ws), { api: "after", result: "view" }))
        .toEqual({ error: ACCOUNT_REMOVED });
    using next = await ws.session(AGENT);
    expect(await next.read({ method: "listUsers" })).toEqual({ error: ACCOUNT_REMOVED });
    expect(await approve(ws, id)).toBe(ACCOUNT_REMOVED);
    expect(await ws.facet.outcomes(1)).toBeUndefined();
    expect(await refusedSubmit(ws, 2, "workspaceWriteRequest")).toBe(ACCOUNT_REMOVED);
    expect(await ws.facet.kept()).toEqual(["before"]);
    expect(await ws.records()).toEqual([]);
    // What was lent before stays lent until its session ends.
    expect((await ws.facet.onKept("before", { method: "listUsers" })).error).toBeUndefined();

    // The connection and its pending action are kept.
    expect(ws.impl.storage.gatekeepers.get(ws.gatekeeperId)).toBeDefined();
    expect(stateOf(ws, id)).toBe("pending");

    await ws.ownerDo.provisionAmbientAccount("admin");
    let [addedId] = await ownerAccounts(ws);
    expect(addedId).not.toBe(accountId);
    expect(await session.read(OPEN(ws), { result: "view" })).toEqual({ kept: "view" });
    expect(await approve(ws, id)).toBeUndefined();
    expect(stateOf(ws, id)).toBe("approved");
  }));

  it("lends nothing through a connection whose owner never had the account",
      () => adminWorkspace(async ws => {
    expect(await ownerAccounts(ws)).toEqual([]);
    using session = await ws.session(AGENT);
    expect(await session.read({ method: "listUsers" }, { api: "api" }))
        .toEqual({ error: ACCOUNT_REMOVED });
    expect(await refusedSubmit(ws, 1, "workspaceWriteRequest")).toBe(ACCOUNT_REMOVED);
    expect(await ws.facet.kept()).toEqual([]);
  }, { account: false }));

  it("is held only by a user who is an admin now and has it", () => adminWorkspace(async ws => {
    let holds = (vendorId = "admin") => ws.ownerDo.holdsGatekeeperAccount(vendorId);
    let accounts = await ownerAccounts(ws);
    expect(accounts).toHaveLength(1);
    let asked = await env.GATEKEEPER_ADMIN.calls();

    expect(await holds()).toBe(true);
    expect(await holds("Admin")).toBe(true);
    expect(await holds("ambientfixture")).toBe(false);
    // A user who is not an admin holds none, whatever their storage keeps.
    ws.env.ADMINS = [OTHER_ADMIN.id];
    expect(await holds()).toBe(false);
    ws.env.ADMINS = [ADMIN.id];
    expect(await holds()).toBe(true);

    // The question provisions nothing and asks no vendor.
    expect(await ownerAccounts(ws)).toEqual(accounts);
    expect(await env.GATEKEEPER_ADMIN.calls()).toEqual(asked);

    await ws.ownerDo.disconnectAccount(accounts[0]!);
    expect(await holds()).toBe(false);
    expect(await ownerAccounts(ws)).toEqual([]);

    // Nor a user who never signed in, though ADMINS names the profile every user object starts
    // with and the object's storage keeps a record: being created is all that is missing.
    let unsigned = await runInDurableObject(
        env.TEST_USER.getByName(`never-signed-in-${crypto.randomUUID()}`),
        async (user: UserDurableObject) => {
      let { storage } = user as unknown as { storage: {
        created: { put(created: boolean): void }; profile: { get(): { id: string } };
        nextAccountId: { put(id: number): void }; connectedAccounts: { put(record: unknown): void };
      } };
      Object.assign(user, { env: { ...ws.env, ADMINS: [storage.profile.get().id] } });
      let account = await env.GATEKEEPER_ADMIN.createAccount();
      storage.connectedAccounts.put({
        id: 0, account, description: await account.describe(), vendorId: "admin",
        autoProvisioned: true,
      });
      storage.nextAccountId.put(1);
      let before = [await user.holdsGatekeeperAccount("admin"), await user.whoamiIfExists()];
      storage.created.put(true);
      return [...before, await user.holdsGatekeeperAccount("admin")];
    });
    expect(unsigned).toEqual([false, null, true]);
  }));

  it("cannot be removed while the mode forces it", () => adminWorkspace(async ws => {
    let [accountId] = await ownerAccounts(ws);
    // Caught inside the account's object: the pool reports a refusal that leaves it as unhandled.
    let refusal = await runInDurableObject(ws.ownerDo, user => (user as UserDurableObject)
        .disconnectAccount(accountId!).then(() => undefined, error => (error as Error).message));
    expect(refusal).toBe("This account is provided automatically and can't be disconnected.");
    expect(await ws.ownerDo.holdsGatekeeperAccount("admin")).toBe(true);
    using session = await ws.session(AGENT);
    expect((await session.read({ method: "listUsers" })).error).toBeUndefined();
  }, { mode: "enabled" }));

  it("is provisioned again, once the mode forces it, when a workspace of its user is opened",
      () => adminWorkspace(async ws => {
    let [accountId] = await ownerAccounts(ws);
    await ws.ownerDo.disconnectAccount(accountId!);
    using session = await ws.session(AGENT);
    expect(await session.read({ method: "listUsers" })).toEqual({ error: ACCOUNT_REMOVED });

    ws.config.ambientGatekeeperModes.admin = "enabled";
    expect(await session.read({ method: "listUsers" })).toEqual({ error: ACCOUNT_REMOVED });
    await ws.impl.ensureAmbientCapsules();
    expect(await ownerAccounts(ws)).toHaveLength(1);
    expect((await session.read({ method: "listUsers" })).error).toBeUndefined();
    // Opening provisioned the account, and still added no connection of its own.
    expect([...ws.impl.storage.gatekeepers.list()].map((record: any) => record.id))
        .toEqual([ws.gatekeeperId]);
  }));
});

// What the deployment needs before a content access request can be filed and claimed, and a write
// run, around `run`: writes on and the level at "content" for the workspace and for the
// AdminSettings object the Admin API reaches, which is given the workspace's own environment (so
// that a test demotes or adds an admin in one place), and the workspace listed in the directory
// with its owner. Everything is put back afterwards.
async function withWrites(ws: AdminWorkspace, run: () => Promise<void>): Promise<void> {
  let settings = env.TEST_ADMIN_SETTINGS.getByName("");
  let directory = env.TEST_USER_DIRECTORY.getByName("");
  Object.assign(ws.env, { ADMIN_WORKSPACE_WRITES: "on", ADMIN_WORKSPACE_ACCESS_MAX: "content" });
  let before = await runInDurableObject(settings, object => {
    let { storage } = object as unknown as { storage: AdminSettingsStorage };
    let was = {
      env: (object as unknown as { env: unknown }).env, config: storage.adminConfig.get(),
    };
    Object.assign(object, { env: ws.env });
    storage.adminConfig.put({ ...was.config, adminWorkspaceAccess: "content" });
    return was;
  });
  await directory.syncWorkspace({ id: ws.id, title: "Triage", ownerId: ws.owner.id }, 1);
  try {
    await run();
  } finally {
    await directory.removeWorkspace(ws.id);
    await runInDurableObject(settings, object => {
      let { storage } = object as unknown as { storage: AdminSettingsStorage };
      Object.assign(object, { env: before.env });
      storage.adminConfig.put(before.config);
    });
  }
}

// The one call that asks for the workspace's own content.
const contentRequestOf = (ws: AdminWorkspace) =>
    [{ method: "requestContentAccess", args: [ws.id, REASON] }];

// The request action number `action` filed, as its one call answered: what a client is shown.
async function filedBy(ws: AdminWorkspace, action: number): Promise<AdminContentRequest> {
  let [outcome] = (await ws.facet.outcomes(action))!;
  expect(outcome!.error).toBeUndefined();
  return outcome!.value as AdminContentRequest;
}

// Who the stored request `id` keeps as having been in the workspace it was filed from.
const insidersOf = (id: string) => runInDurableObject(env.TEST_ADMIN_SETTINGS.getByName(""),
    object => (object as unknown as { storage: AdminSettingsStorage })
        .storage.contentAccessRequests.get(id)?.insiders);

// What `admin`'s claim of request `id` for their approval comes to: "claimed", which spends the
// request, or the code it is refused with. Asked inside the object, so that the error is the one
// thrown.
const claim = (id: string, admin: AiChatAuthorInfo) => runInDurableObject(
    env.TEST_ADMIN_SETTINGS.getByName(""), async object => {
  try {
    await object.claimContentAccess(id, { admin: admin.id, sessionId: "approver", via: "api" });
    return "claimed";
  } catch (error) {
    return getAdminGrantErrorCode(error);
  }
});

// The records of the workspace of kind `kind`, which here all name it.
const recordsOf = async <Kind extends "grant" | "write">(ws: AdminWorkspace, kind: Kind) =>
    (await ws.records() as unknown as AdminAuditRecord[]).filter(
        (record): record is Extract<AdminGrantRecord | AdminWriteRecord, { kind: Kind }> =>
            record.kind === kind);

describe("a write an agent asks for", () => {
  it("runs once a person approves its action, as the owner's, from the chat that queued it",
      () => adminWorkspace(ws => withWrites(ws, async () => {
    let id = await queueAction(ws, 1, "workspaceWriteRequest",
        [{ method: "writeWorkspace", args: [ws.id, "restartWorkspace", {}, REASON] }]);
    expect(await recordsOf(ws, "write")).toEqual([]);

    expect(await approve(ws, id, OTHER_ADMIN)).toBeUndefined();
    expect(await recordsOf(ws, "write")).toMatchObject([{
      admin: ADMIN.id, via: "gatekeeper", agent: { workspaceId: ws.id, chatId: 5 },
      workspaceId: ws.id, method: "restartWorkspace", reason: REASON,
    }]);
  })));
});

describe("a request for content access an agent files", () => {
  // Two more deployment admins: one who is never in the workspace, and one who joins it late.
  const OUTSIDE_ADMIN: AiChatAuthorInfo =
      { type: "user", id: "outside-admin@example.test", name: "Outside admin" };
  const LATE_ADMIN: AiChatAuthorInfo =
      { type: "user", id: "late-admin@example.test", name: "Late admin" };
  const ADMINS = { admins: [ADMIN.id, OTHER_ADMIN.id, OUTSIDE_ADMIN.id, LATE_ADMIN.id] };
  const { secondAdminRequired } = ADMIN_GRANT_ERROR_CODES;
  const OWNER_CALLER = { profileId: ADMIN.id, isOwner: true };

  // Shares the workspace with `user`, as its owner does.
  async function share(ws: AdminWorkspace, user: AiChatAuthorInfo): Promise<void> {
    (await ws.impl.getSharingManager()).addCollaborator(
        { caller: OWNER_CALLER, profile: user, grant: "workspace" });
  }

  // Takes `user` out of the workspace, as its owner does.
  async function unshare(ws: AdminWorkspace, user: AiChatAuthorInfo): Promise<void> {
    (await ws.impl.getSharingManager()).removeCollaborator(OWNER_CALLER, user.id, []);
  }

  it("cannot be approved by the owner, a member or whoever approved its filing",
      () => adminWorkspace(ws => withWrites(ws, async () => {
    await share(ws, OTHER_ADMIN);
    let id = await queueAction(ws, 1, "contentAccessRequest", contentRequestOf(ws));
    expect(await approve(ws, id, OTHER_ADMIN)).toBeUndefined();

    // The request is the owner's, from the chat that queued it, and shows no client the list.
    let filed = await filedBy(ws, 1);
    expect(filed).toMatchObject({
      workspaceId: ws.id, state: "pending", requestedBy: ADMIN.id, via: "gatekeeper",
      agent: { workspaceId: ws.id, chatId: 5 },
    });
    expect(filed).not.toHaveProperty("insiders");
    expect(await insidersOf(filed.id)).toEqual([ADMIN.id, OTHER_ADMIN.id]);
    let records = await recordsOf(ws, "grant");
    expect(records).toMatchObject([{
      method: "requestContentAccess", requestId: filed.id, admin: ADMIN.id, via: "gatekeeper",
      agent: { workspaceId: ws.id, chatId: 5 },
    }]);
    expect(records[0]).not.toHaveProperty("insiders");
    expect(JSON.stringify(records)).not.toContain(OTHER_ADMIN.id);

    expect(await claim(filed.id, ADMIN)).toBe(secondAdminRequired);
    expect(await claim(filed.id, OTHER_ADMIN)).toBe(secondAdminRequired);
    expect(await claim(filed.id, OUTSIDE_ADMIN)).toBe("claimed");
  }), ADMINS));

  it("keeps its list as it was when filed: a member who leaves stays on it, one who joins is not",
      () => adminWorkspace(ws => withWrites(ws, async () => {
    await share(ws, OTHER_ADMIN);
    let id = await queueAction(ws, 1, "contentAccessRequest", contentRequestOf(ws));
    // The owner approves the filing: the member had no hand in it, and is on the list all the same.
    expect(await approve(ws, id, ADMIN)).toBeUndefined();
    let filed = await filedBy(ws, 1);
    expect(await insidersOf(filed.id)).toEqual([ADMIN.id, OTHER_ADMIN.id]);
    expect(await claim(filed.id, OTHER_ADMIN)).toBe(secondAdminRequired);

    await unshare(ws, OTHER_ADMIN);
    await share(ws, LATE_ADMIN);
    expect(await insidersOf(filed.id)).toEqual([ADMIN.id, OTHER_ADMIN.id]);
    expect(await claim(filed.id, OTHER_ADMIN)).toBe(secondAdminRequired);
    expect(await claim(filed.id, LATE_ADMIN)).toBe("claimed");
  }), ADMINS));

  it("counts everyone the workspace is shared with, an admin or not, and whoever decided once",
      () => adminWorkspace(ws => withWrites(ws, async () => {
    await share(ws, NOT_ADMIN);
    await share(ws, OTHER_ADMIN);
    let id = await queueAction(ws, 1, "contentAccessRequest", contentRequestOf(ws));
    expect(await approve(ws, id, OTHER_ADMIN)).toBeUndefined();
    let first = await filedBy(ws, 1);
    let insiders = await insidersOf(first.id);
    expect(insiders?.toSorted()).toEqual([ADMIN.id, NOT_ADMIN.id, OTHER_ADMIN.id].toSorted());
    expect(insiders?.[0]).toBe(ADMIN.id);
    // A workspace has one pending request at a time: the next is filed once this one is denied.
    await runInDurableObject(env.TEST_ADMIN_SETTINGS.getByName(""), object =>
        object.denyContentAccess(first.id, { admin: OUTSIDE_ADMIN.id, sessionId: "s", via: "api" }));

    // Whoever approved the filing is on the list, in the sharing list or not.
    let next = await queueAction(ws, 2, "contentAccessRequest", contentRequestOf(ws));
    expect(await approve(ws, next, LATE_ADMIN)).toBeUndefined();
    let decided = await filedBy(ws, 2);
    expect(await insidersOf(decided.id)).toContain(LATE_ADMIN.id);
    expect(await claim(decided.id, LATE_ADMIN)).toBe(secondAdminRequired);
    expect(await claim(decided.id, OUTSIDE_ADMIN)).toBe("claimed");
  }), ADMINS));

  it("keeps no list for a request an admin files from a client", () => adminWorkspace(ws =>
      withWrites(ws, async () => {
    await share(ws, OTHER_ADMIN);
    let api = new AdminApiImpl(ws.impl.ctx, ws.env, ADMIN.id, { via: "cli" });
    let filed = await api.requestContentAccess(ws.id, REASON);
    expect(await insidersOf(filed.id)).toBeUndefined();
    expect(await claim(filed.id, ADMIN)).toBe(secondAdminRequired);
    expect(await claim(filed.id, OTHER_ADMIN)).toBe("claimed");
  }), ADMINS));

  // A member who writes code that files a request later, leaves, and approves it from outside
  // would be nobody the request knows. No rule files it: a person present approves the filing,
  // and is on the list.
  it("is never filed by a rule, so a member who left cannot have it filed in their absence",
      () => adminWorkspace(ws => withWrites(ws, async () => {
    await share(ws, OTHER_ADMIN);
    enableRule(ws, "contentAccessRequest", OTHER_ADMIN);
    await unshare(ws, OTHER_ADMIN);

    // The code the member left behind asks for content: its kind waits, whatever the rule.
    let id = await queueAction(ws, 1, "contentAccessRequest", contentRequestOf(ws),
        { claims: { autoApprovable: true } });
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);
    expect(stateOf(ws, id)).toBe("pending");
    expect(await ws.facet.outcomes(1)).toBeUndefined();
    expect(await recordsOf(ws, "grant")).toEqual([]);

    // Only once a person present approves that card is the request filed, with that person on
    // its list: the owner, alone in the workspace by now.
    expect(await approve(ws, id, ADMIN)).toBeUndefined();
    let filed = await filedBy(ws, 1);
    expect((await recordsOf(ws, "grant")).map(record => [record.method, record.requestId]))
        .toEqual([["requestContentAccess", filed.id]]);

    // The member who left is a second person, and may approve the request.
    expect(await insidersOf(filed.id)).toEqual([ADMIN.id]);
    expect(await claim(filed.id, ADMIN)).toBe(secondAdminRequired);
    expect(await claim(filed.id, OTHER_ADMIN)).toBe("claimed");
  }), ADMINS));
});

describe("a spawned chat", () => {
  const GADGET_ID = 100;

  // Spawns a chat through a spawner whose config names `spawnerEnv`, and returns its id.
  async function spawnChat(ws: AdminWorkspace, spawnerEnv: Record<string, number>)
      : Promise<number> {
    let config = { displayName: "Triager", modelId: "m" };
    let client = await ws.impl.addGatekeeper(
        ws.impl.ctx.exports.AgentSpawnerGatekeeper(
            { props: { config, creatorUserId: "owner-user-do" } }),
        { type: "agentSpawner", config }, "owner-user-do", undefined,
        Object.fromEntries(Object.entries(spawnerEnv).map(([name, target]) => [name, { target }])));
    let known = new Set([...ws.impl.storage.chatMeta.list()].map((meta: any) => meta.id));
    using spawner = await client.openSession();
    await spawner.spawn("Triage", "Look into the report.");
    let [spawned] = [...ws.impl.storage.chatMeta.list()].filter((meta: any) => !known.has(meta.id));
    return spawned.id;
  }

  it("holds the admin connection only when its spawner's config names it",
      () => adminWorkspace(async ws => {
    ws.impl.storage.gadgets.put({
      type: "gadget", id: GADGET_ID, title: "Gadget", created: new Date(0), bindingName: "GADGET",
      bindings: {},
    });

    // The workspace has the connection, and the spawner names a gadget alone.
    let without = await spawnChat(ws, { GADGET: GADGET_ID });
    expect(ws.impl.storage.chatContext.get(without).bindings).toEqual({ GADGET: GADGET_ID });

    let named = await spawnChat(ws, { GADGET: GADGET_ID, ADMIN: ws.gatekeeperId });
    expect(ws.impl.storage.chatContext.get(named).bindings)
        .toEqual({ GADGET: GADGET_ID, ADMIN: ws.gatekeeperId });

    // A session of that chat's agent is recorded with the spawned chat's id.
    using session = await ws.session({ from: "agent", chatId: named });
    expect(await session.read(OPEN(ws), { result: "view" })).toEqual({ kept: "view" });
    expect((await ws.records()).map(record => record.agent))
        .toEqual([{ workspaceId: ws.id, chatId: named }]);
  }));
});
