// How a workspace lends its owner's Admin API to the admin gatekeeper (OverseerImpl.lendAdminApi()
// and the queue openGatekeeperSession() gives its sessions): over a real OverseerDurableObject and
// a fixture facet that stands for the gatekeeper, a Worker that keeps everything it is given
// (FakeAdminGatekeeper in test-worker.ts).
//
// The workspace inspects itself where a test needs a view: the Admin API reaches it through its
// own Durable Object stub, as it reaches any workspace, so the view is the native stub a real
// lend returns. The audit log is the real object behind ctx.exports.
//
// Time is moved with a spy on Date.now(): a session's deadline is fixed by its queue when the
// queue is made, and neither the queue nor the lend takes a clock from outside.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminAccessRecord } from "@gadgets/workshop-shared/api";
import { ADMIN_AGENT_LEND_SECONDS } from "@gadgets/workshop-shared/admin-agent";
import type { GatekeeperCaller } from "../src/storage-schema/overseer-storage.js";
import type { UserDurableObject } from "../src/user.js";
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
    GATEKEEPER_INSTANCEADMIN: Service<FakeAdminVendor>;
  }
}

const REASON = "Looking into an issue report";
const LEND_MS = ADMIN_AGENT_LEND_SECONDS * 1000;
const ENDED = "This Admin API session has ended. Open a new one.";
// What createAdminAccessError(notAdmin) says, as it arrives over RPC.
const NOT_ADMIN_MESSAGE = "Only a deployment admin can inspect a workspace or a user.";
// What a connection is told once its workspace's owner holds no account of the admin gatekeeper.
const ACCOUNT_REMOVED = "This workspace's owner has removed the deployment admin account, so " +
    "this connection reaches nothing. Add the account again from Connectors, or remove the " +
    "connection.";
const AGENT: GatekeeperCaller = { from: "agent", chatId: 5 };
const OPEN = (ws: AdminWorkspace, options?: object) =>
    ({ method: "inspectWorkspace", args: options ? [ws.id, REASON, options] : [ws.id, REASON] });

afterEach(() => { vi.restoreAllMocks(); });

describe("a session of the admin gatekeeper", () => {
  it("reads through the lent Admin API", () => adminWorkspace(async ws => {
    using session = await ws.session(AGENT);
    expect(await session.read({ method: "listUsers" })).toEqual({ value: { users: [] } });
    expect((await session.read({ method: "getSettings" })).error).toBeUndefined();
  }));

  it("is refused every omitted method", () => adminWorkspace(async ws => {
    using session = await ws.session(AGENT);
    expect(await session.read({ method: "setSiteName", args: ["x"] }))
        .toEqual({ error: "AdminApi.setSiteName() is not available through the admin gatekeeper." });
    expect(await session.read({ method: "checkForUpdates" }))
        .toEqual({ error: "AdminApi.checkForUpdates() is not available through the admin gatekeeper." });
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

    ws.config.ambientGatekeeperModes.instanceadmin = "disabled";
    let off = { error: "Gatekeeper is disabled." };
    expect(await ws.facet.onKept("api", { method: "listUsers" })).toEqual(off);
    expect(await ws.facet.onKept("view", { method: "describe" })).toEqual(off);
    expect(await session.read({ method: "listUsers" })).toEqual(off);

    ws.config.ambientGatekeeperModes.instanceadmin = "optional";
    ws.config.disabledGatekeepers = ["instanceadmin"];
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
    for (let method of ["listChats", "listFiles", "inspectUser"]) {
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

describe("who is lent the Admin API", () => {
  it("lends nothing in a workspace whose owner is not an admin", () => adminWorkspace(async ws => {
    using session = await ws.session(AGENT);
    expect(await session.read({ method: "listUsers" }, { api: "api" }))
        .toEqual({ error: NOT_ADMIN_MESSAGE });
    expect(await ws.facet.kept()).toEqual([]);
  }, { owner: NOT_ADMIN }));

  it("lends nothing while the vendor's mode is disabled", () => adminWorkspace(async ws => {
    ws.config.ambientGatekeeperModes.instanceadmin = "disabled";
    using session = await ws.session(AGENT);
    expect(await session.read({ method: "listUsers" }))
        .toEqual({ error: "Gatekeeper is disabled." });

    ws.config.ambientGatekeeperModes.instanceadmin = "enabled";
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

  it("lends nothing once the user stopped the turn its session belongs to",
      () => adminWorkspace(async ws => {
    vi.spyOn(ws.impl, "isLiveExecution").mockReturnValue(true);
    let stopped = vi.spyOn(ws.impl, "isStoppedExecution").mockReturnValue(false);
    using session = await ws.impl.openGatekeeperSession(ws.gatekeeperId,
        await ws.impl.getGatekeeperFacet(ws.gatekeeperId), AGENT, "execution-1");
    expect((await session.read({ method: "listUsers" }, { api: "api" })).error).toBeUndefined();

    stopped.mockReturnValue(true);
    let ended = { error: "The user stopped the agent turn this session belongs to." };
    expect(await session.read({ method: "listUsers" })).toEqual(ended);
    expect(await ws.facet.onKept("api", { method: "listUsers" })).toEqual(ended);
  }));

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
      if (storage.connectedAccounts.get(id)?.vendorId === "instanceadmin") ids.push(id);
    }
    return ids;
  });
}

describe("the owner's account of the admin gatekeeper", () => {
  it("ends its connections when it is removed, and brings them back when it is added again",
      () => adminWorkspace(async ws => {
    using session = await ws.session(AGENT);
    expect((await session.read({ method: "listUsers" }, { api: "before" })).error).toBeUndefined();

    let [accountId] = await ownerAccounts(ws);
    await ws.ownerDo.disconnectAccount(accountId!);
    expect(await ownerAccounts(ws)).toEqual([]);

    // Nothing more is lent, to this session or to another.
    expect(await session.read(OPEN(ws), { api: "after", result: "view" }))
        .toEqual({ error: ACCOUNT_REMOVED });
    using next = await ws.session(AGENT);
    expect(await next.read({ method: "listUsers" })).toEqual({ error: ACCOUNT_REMOVED });
    expect(await ws.facet.kept()).toEqual(["before"]);
    expect(await ws.records()).toEqual([]);
    // What was lent before stays lent until its session ends.
    expect((await ws.facet.onKept("before", { method: "listUsers" })).error).toBeUndefined();

    // The connection is kept.
    expect(ws.impl.storage.gatekeepers.get(ws.gatekeeperId)).toBeDefined();

    await ws.ownerDo.provisionAmbientAccount("instanceadmin");
    let [addedId] = await ownerAccounts(ws);
    expect(addedId).not.toBe(accountId);
    expect(await session.read(OPEN(ws), { result: "view" })).toEqual({ kept: "view" });
  }));

  it("lends nothing through a connection whose owner never had the account",
      () => adminWorkspace(async ws => {
    expect(await ownerAccounts(ws)).toEqual([]);
    using session = await ws.session(AGENT);
    expect(await session.read({ method: "listUsers" }, { api: "api" }))
        .toEqual({ error: ACCOUNT_REMOVED });
    expect(await ws.facet.kept()).toEqual([]);
  }, { account: false }));

  it("is held only by a user who is an admin now and has it", () => adminWorkspace(async ws => {
    let holds = (vendorId = "instanceadmin") => ws.ownerDo.holdsGatekeeperAccount(vendorId);
    let accounts = await ownerAccounts(ws);
    expect(accounts).toHaveLength(1);
    let asked = await env.GATEKEEPER_INSTANCEADMIN.calls();

    expect(await holds()).toBe(true);
    expect(await holds("InstanceAdmin")).toBe(true);
    expect(await holds("ambientfixture")).toBe(false);
    // A user who is not an admin holds none, whatever their storage keeps.
    ws.env.ADMINS = [OTHER_ADMIN.id];
    expect(await holds()).toBe(false);
    ws.env.ADMINS = [ADMIN.id];
    expect(await holds()).toBe(true);

    // The question provisions nothing and asks no vendor.
    expect(await ownerAccounts(ws)).toEqual(accounts);
    expect(await env.GATEKEEPER_INSTANCEADMIN.calls()).toEqual(asked);

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
      let account = await env.GATEKEEPER_INSTANCEADMIN.createAccount();
      storage.connectedAccounts.put({
        id: 0, account, description: await account.describe(), vendorId: "instanceadmin",
        autoProvisioned: true,
      });
      storage.nextAccountId.put(1);
      let before = [await user.holdsGatekeeperAccount("instanceadmin"), await user.whoamiIfExists()];
      storage.created.put(true);
      return [...before, await user.holdsGatekeeperAccount("instanceadmin")];
    });
    expect(unsigned).toEqual([false, null, true]);
  }));

  it("cannot be removed while the mode forces it", () => adminWorkspace(async ws => {
    let [accountId] = await ownerAccounts(ws);
    // Caught inside the account's object: the pool reports a refusal that leaves it as unhandled.
    let refusal = await runInDurableObject(ws.ownerDo, user => (user as UserDurableObject)
        .disconnectAccount(accountId!).then(() => undefined, error => (error as Error).message));
    expect(refusal).toBe("This account is provided automatically and can't be disconnected.");
    expect(await ws.ownerDo.holdsGatekeeperAccount("instanceadmin")).toBe(true);
    using session = await ws.session(AGENT);
    expect((await session.read({ method: "listUsers" })).error).toBeUndefined();
  }, { mode: "enabled" }));

  it("is provisioned again, once the mode forces it, when a workspace of its user is opened",
      () => adminWorkspace(async ws => {
    let [accountId] = await ownerAccounts(ws);
    await ws.ownerDo.disconnectAccount(accountId!);
    using session = await ws.session(AGENT);
    expect(await session.read({ method: "listUsers" })).toEqual({ error: ACCOUNT_REMOVED });

    ws.config.ambientGatekeeperModes.instanceadmin = "enabled";
    expect(await session.read({ method: "listUsers" })).toEqual({ error: ACCOUNT_REMOVED });
    await ws.impl.ensureAmbientCapsules();
    expect(await ownerAccounts(ws)).toHaveLength(1);
    expect((await session.read({ method: "listUsers" })).error).toBeUndefined();
    // Opening provisioned the account, and still added no connection of its own.
    expect([...ws.impl.storage.gatekeepers.list()].map((record: any) => record.id))
        .toEqual([ws.gatekeeperId]);
  }));
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
