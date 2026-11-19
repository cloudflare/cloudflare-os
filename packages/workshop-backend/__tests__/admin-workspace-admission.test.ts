// Who a workspace admits once it has, or has read through, the admin gatekeeper's connection
// (OverseerImpl.adminsOnly() and admitsNonOwner()): beside its owner, only users who are deployment
// admins at that moment, at every gate a non-owner passes. A workspace without the connection
// admits whoever it is shared with, and one that had the connection and read nothing through the
// whole admin binding does so again once the connection is removed.
//
// Runs against a real OverseerDurableObject with its real sharing manager, opened through
// OverseerDurableObject.open() as each user, over the fixture facet that stands for the admin
// gatekeeper (FakeAdminGatekeeper in test-worker.ts). The accounts are fakes that answer a profile,
// and two things are stood in for: a scheduled restart is recorded rather than carried out, so a
// session a test holds outlives it, and observer verification (OverseerImpl.ensureObserver()) is
// recorded rather than run, since it is not what admission decides here. A second admin's whole
// open, account choice and verification included, is the integration suite's.

import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ISSUE_REPORT_ERROR_CODES, OPEN_WORKSPACE_ERROR_CODES, getIssueReportErrorCode,
  getOpenWorkspaceErrorCode,
  type AiChatAuthorInfo, type CollaboratorGrant, type IssueReportContext, type Overseer,
} from "@gadgets/workshop-shared/api";
import {
  ADMIN_AGENT_ACTIONS, ADMIN_BINDING_SUBRESOURCE, ADMIN_GATEKEEPER_VENDOR_ID,
  type AdminAgentAction,
} from "@gadgets/workshop-shared/admin-agent";
import type { OverseerDurableObject } from "../src/overseer.js";
import {
  ADMIN, NOT_ADMIN, OTHER_ADMIN, adminWorkspace, type AdminWorkspace, type FakeAdminFacet,
  type FakeAdminSessionStub,
} from "./admin-agent-helpers.js";
// Load the whole backend (the pool's `main`) up front, so its slow load does not count against the
// first test's timeout.
import "./test-worker.js";

// A collaborator who is not a deployment admin, a second deployment admin, and two users who are
// neither admins nor, until a test adds them, collaborators.
const NELL = NOT_ADMIN;
const GRACE = OTHER_ADMIN;
const MAYA: AiChatAuthorInfo = { type: "user", id: "maya@example.test", name: "Maya" };
const OMAR: AiChatAuthorInfo = { type: "user", id: "omar@example.test", name: "Omar" };

const RESOURCE_URL = "https://workshop.example/admin";
const CHAT_ID = 7;
const GADGET = 100;
// The subresource id a session limited to one report puts on what it reads of the reporter's
// workspace: any id other than ADMIN_BINDING_SUBRESOURCE, which is all the workspace reads.
const REPORT_SUBRESOURCE = "admin:report";
// What createAdminAccessError(notAdmin) says.
const NOT_ADMIN_MESSAGE =
    "Only a deployment admin can inspect a workspace or a user, or change a workspace.";
const CONNECTION_REFUSAL = "This workspace has the deployment admin connection, so only " +
    "deployment admins can be added to it. Remove the connection to share it with others.";
const READS_REFUSAL = "This workspace has read through the deployment admin connection and its " +
    "chats hold what was read, so only deployment admins can be added to it. Removing the " +
    "connection does not change that.";
const DENIED = OPEN_WORKSPACE_ERROR_CODES.workspaceAccessDenied;

// A user object's id, as the fake namespace derives it from the account's name.
function userIdOf(user: AiChatAuthorInfo): string {
  return `user-do:${user.id}`;
}

type Workspace = AdminWorkspace & {
  /** The reason of each restart the workspace scheduled. */
  restarts: string[];
  /** Whom the workspace went on to verify as an observer, by profile id, in order. */
  verified: string[];
  /** The collaborators' user objects a chat head was sent to, by id. */
  arrivals: string[];
  /** The collaborators' user objects an index of the workspace's outputs was sent to, by id. */
  outputs: string[];
};

// A workspace of ADMIN's, whose deployment admins are ADMIN and GRACE, with a chat and a gadget,
// and with the admin connection unless `connection` is false. Nobody collaborates on it yet.
async function withWorkspace(run: (ws: Workspace) => Promise<void>,
                             options: { connection?: boolean } = {}): Promise<void> {
  await adminWorkspace(async base => {
    let ws: Workspace = { ...base, restarts: [], verified: [], arrivals: [], outputs: [] };
    let { impl } = ws;
    let adminClass = async () => ({
      class: impl.ctx.exports.FakeAdminGatekeeper({ props: {} }),
      vendorId: ADMIN_GATEKEEPER_VENDOR_ID, typeUrlPattern: RESOURCE_URL,
    });
    let accounts = new Map([NELL, GRACE, MAYA, OMAR].map(user => [userIdOf(user), user]));
    let ownerUsers = impl.users;
    impl.users = {
      idFromString: (id: string) => id,
      idFromName: (name: string) => `user-do:${name}`,
      get: (id: string) => {
        // The owner's account is the helper's, which asks the real user object about the account.
        if (id === impl.ownerId) {
          return { ...ownerUsers.get(id), getGatekeeperClassFor: adminClass };
        }
        let profile = accounts.get(id);
        return {
          id,
          whoami: async () => {
            if (!profile) throw new Error(`No account behind ${id}.`);
            return profile;
          },
          whoamiIfExists: async () => profile ?? null,
          getGatekeeperClassFor: adminClass,
          messageArrived: async (_workspaceId: string, _chatId: number, head: unknown) => {
            if (head) ws.arrivals.push(id);
          },
          recordSharedWorkspaceOpen: async () => {},
          syncWorkspaceOutputs: async () => { ws.outputs.push(id); },
          forgetSharedWorkspace: async () => {},
          updateSharedWorkspaceRole: async () => {},
        };
      },
    };
    impl.ensureAmbientCapsules = async () => {};
    impl.markOutputsDirty = () => {};
    impl.scheduleAccessRestart = async (reason: string) => { ws.restarts.push(reason); };
    impl.ensureObserver = async (profileId: string) => { ws.verified.push(profileId); };
    impl.storage.chatMeta.put(
        { id: CHAT_ID, title: "Plans", started: new Date(0), lastActive: new Date(0) });
    impl.storage.gadgets.put(
        { type: "gadget", id: GADGET, title: "App", created: new Date(0), bindingName: "APP",
          bindings: {} });
    await run(ws);
  }, options);
}

// Shares the workspace with `user` as its owner does, without asking the admission rule: how a
// collaborator who was there before the rule began is in the sharing list.
async function share(ws: Workspace, user: AiChatAuthorInfo, grant: CollaboratorGrant = "workspace")
    : Promise<void> {
  (await ws.impl.getSharingManager()).addCollaborator(
      { caller: { profileId: ws.owner.id, isOwner: true }, profile: user, grant });
}

async function collaborators(ws: Workspace): Promise<string[]> {
  let listed = (await ws.impl.getSharingManager()).listCollaborators();
  return listed.map((entry: { profile: AiChatAuthorInfo }) => entry.profile.id).toSorted();
}

// Opens the workspace as `user` does, with `shareKey` when they follow a share link.
async function open(ws: Workspace, user: AiChatAuthorInfo, shareKey?: string)
    : Promise<Overseer & Disposable> {
  // The session keeps its own duplicate of the stub.
  using notifyClosed = new NativeRpcStub<() => void>(() => {});
  let userId = user.id === ws.owner.id ? ws.impl.ownerId : userIdOf(user);
  return await ws.instance.open(userId, user.id, notifyClosed, shareKey) as Overseer & Disposable;
}

// What opening the workspace comes to for `user`: "admitted", or the code of the refusal.
async function opening(ws: Workspace, user: AiChatAuthorInfo, shareKey?: string): Promise<string> {
  try {
    using _client = await open(ws, user, shareKey);
    return "admitted";
  } catch (error) {
    return getOpenWorkspaceErrorCode(error) ?? `unexpected: ${(error as Error).message}`;
  }
}

// What a call on a session comes to: undefined, or the message of its refusal.
async function refusal(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call;
  } catch (error) {
    return (error as Error).message;
  }
}

// Adds the admin connection as the owner does from the connection picker, and returns its id.
async function addConnection(ws: Workspace): Promise<number> {
  using client = await open(ws, ws.owner);
  using connection = await client.newGatekeeper(1, RESOURCE_URL) as
      unknown as Disposable & { getId(): Promise<number> };
  ws.gatekeeperId = await connection.getId();
  return ws.gatekeeperId;
}

// Removes connection `id`, the admin connection by default, as its owner does.
async function removeConnection(ws: Workspace, id = ws.gatekeeperId): Promise<void> {
  using client = await open(ws, ws.owner);
  using connection = await client.getGatekeeperById(id) as
      unknown as Disposable & { remove(): Promise<void> };
  await connection.remove();
}

// A session of connection `id`, the admin connection by default, as its owner opens one.
async function sessionOf(ws: Workspace, id = ws.gatekeeperId): Promise<FakeAdminSessionStub> {
  return ws.impl.openGatekeeperSession(
      id, await ws.impl.getGatekeeperFacet(id), { from: "user" });
}

// Records an observation through connection `id`, as the gatekeeper does before a read.
async function observe(ws: Workspace, claims: object, id = ws.gatekeeperId): Promise<void> {
  using session = await sessionOf(ws, id);
  await session.observe({ title: "Read", description: "A read.", ...claims });
}

// What the workspace keeps of what was read: the restricted-data latch, the mark of a read through
// the whole admin binding, and the rule that follows.
function marks(ws: Workspace) {
  return {
    restricted: ws.impl.storage.containsRestrictedData.get(),
    adminReads: ws.impl.storage.adminReads.get(),
    adminsOnly: ws.impl.adminsOnly(),
  };
}

// Gives `user` a stored account choice for every connection, as a collaborator who was verified
// has one: without the admission rule, mayReadChatState() would then answer them.
function chooseAccounts(ws: Workspace, user: AiChatAuthorInfo) {
  let record = {
    profileId: user.id, observerId: `observer-${user.id}`,
    accountChoices: Object.fromEntries(
        [...ws.impl.storage.gatekeepers.list()].map((connection: { id: number }) =>
            [connection.id, 1])),
  };
  ws.impl.storage.observers.put(record);
  return record;
}

function readsChatState(ws: Workspace, user: AiChatAuthorInfo): Promise<boolean> {
  return ws.impl.mayReadChatState(userIdOf(user), user.id);
}

// Starts chat `chatId` and returns the collaborators' user objects its head was sent to.
async function chatHeadRecipients(ws: Workspace, chatId: number): Promise<string[]> {
  ws.arrivals.length = 0;
  // Each chat has its own time of last activity: the workspace indexes its chats by it.
  ws.impl.storage.chatMeta.put(
      { id: chatId, title: "Triage", started: new Date(0), lastActive: new Date(chatId) });
  await ws.impl.deliverDirtyChats({ chatId });
  return [...new Set(ws.arrivals)].toSorted();
}

// What the workspace answers `user` for a report naming `context`: whether they own it, or
// "refused" for `contextNotFound`.
async function reportContext(ws: Workspace, user: AiChatAuthorInfo,
    context: Pick<IssueReportContext, "chatId" | "gadgetId"> = {})
    : Promise<{ owner: boolean } | "refused"> {
  let userId = user.id === ws.owner.id ? ws.impl.ownerId : userIdOf(user);
  try {
    return await ws.instance.issueReportContext(userId, context);
  } catch (error) {
    expect(getIssueReportErrorCode(error)).toBe(ISSUE_REPORT_ERROR_CODES.contextNotFound);
    return "refused";
  }
}

// Queues action number `action` of `kind` on the admin connection, planned to make `calls`, and
// returns its record's id.
async function queueAction(ws: Workspace, action: number, kind: AdminAgentAction,
    calls: { method: string; args?: unknown[] }[] = []): Promise<number> {
  let facet: FakeAdminFacet = await ws.impl.getGatekeeperFacet(ws.gatekeeperId);
  await facet.plan(action, calls);
  using session = await sessionOf(ws);
  await session.submit(action, {
    title: ADMIN_AGENT_ACTIONS[kind].kind.label, description: "What will be posted or set.",
    implementsRevert: false, autoApprovable: ADMIN_AGENT_ACTIONS[kind].autoApprovable,
    actionKind: ADMIN_AGENT_ACTIONS[kind].kind,
  });
  return [...ws.impl.storage.actions.list()]
      .filter((record: any) => record.type === "action" && record.action === action).at(-1).id;
}

describe("a workspace without the admin connection", () => {
  it("admits whoever it is shared with, in either role and by a share link",
      () => withWorkspace(async ws => {
    await share(ws, NELL);
    await share(ws, MAYA, { gadgetId: GADGET });
    expect(ws.impl.adminsOnly()).toBeUndefined();

    expect(await opening(ws, NELL)).toBe("admitted");
    expect(await opening(ws, MAYA)).toBe("admitted");
    {
      using shell = await open(ws, MAYA);
      using _gadget = await shell.getGadget(GADGET) as unknown as Disposable;
    }
    expect(await readsChatState(ws, NELL)).toBe(true);
    expect(await chatHeadRecipients(ws, 20)).toEqual([userIdOf(NELL)]);

    expect(await reportContext(ws, NELL, { chatId: CHAT_ID })).toEqual({ owner: false });
    expect(await reportContext(ws, NELL, { chatId: CHAT_ID + 1 })).toBe("refused");

    // A share link opens for a non-admin, who is then a collaborator, and so does an invitation.
    let key: string;
    {
      using client = await open(ws, ws.owner);
      ({ key } = await client.createShareLink("workspace"));
      expect(await client.addCollaborator(GRACE.id, "workspace")).toMatchObject(
          { profile: { id: GRACE.id } });
    }
    expect(await opening(ws, OMAR)).toBe(DENIED);
    expect(await opening(ws, OMAR, key)).toBe("admitted");
    expect(await collaborators(ws)).toEqual([GRACE.id, MAYA.id, NELL.id, OMAR.id].toSorted());
  }, { connection: false }));
});

describe("a workspace that has the admin connection", () => {
  it.each(["build", "use"] as const)(
      "refuses a %s collaborator who is not an admin, and ends the session they held",
      role => withWorkspace(async ws => {
    await share(ws, NELL, role === "build" ? "workspace" : { gadgetId: GADGET });
    using held = await open(ws, NELL);
    // The owner's own session is no collaborator's: nothing is scheduled until one is.
    expect(ws.restarts).toEqual([]);
    ws.verified.length = 0;

    await addConnection(ws);
    expect(ws.impl.adminsOnly()).toBe("connection");
    expect(ws.restarts).toEqual(["Gadget restarted because a new connection was added."]);

    // Refused as someone the workspace was never shared with, before anyone is verified.
    expect(await opening(ws, NELL)).toBe(DENIED);
    expect(ws.verified).toEqual([]);
    expect(await collaborators(ws)).toEqual([NELL.id]);
    // The session the stand-in restart left her gets nothing more through the gates.
    if (role === "use") {
      expect(await refusal(held.getGadget(GADGET))).toBe(`No such gadget: ${GADGET}`);
    }
    expect(await ws.impl.authorizeGadget(NELL.id, ws.impl.users.get(userIdOf(NELL)), GADGET))
        .toBe(false);
    // Nor may she open the gadget as a snapshot, which verifies nothing.
    expect(await ws.impl.gadgetOpenMode(NELL.id, GADGET)).toBeNull();
    expect(await ws.impl.authorizeCollaborator(NELL.id, ws.impl.users.get(userIdOf(NELL))))
        .toBeNull();
    expect(ws.verified).toEqual([]);

    // Nor is she sent a chat head, whatever accounts she had chosen.
    chooseAccounts(ws, NELL);
    expect(await readsChatState(ws, NELL)).toBe(false);
    expect(await chatHeadRecipients(ws, 20)).toEqual([]);
  }, { connection: false }));

  it("spends no share link on someone who is not an admin", () => withWorkspace(async ws => {
    let key: string;
    {
      using client = await open(ws, ws.owner);
      ({ key } = await client.createShareLink("workspace"));
    }
    expect(await opening(ws, MAYA, key)).toBe(DENIED);
    expect(await collaborators(ws)).toEqual([]);
    expect(ws.verified).toEqual([]);

    // The link still opens for an admin, who is stored as its collaborator.
    expect(await opening(ws, GRACE, key)).toBe("admitted");
    expect(await collaborators(ws)).toEqual([GRACE.id]);
    expect(ws.verified).toEqual([GRACE.id]);
  }));

  it("lets only a deployment admin be added, and tells the inviter why",
      () => withWorkspace(async ws => {
    using client = await open(ws, ws.owner);
    expect(await refusal(client.addCollaborator(NELL.id, "workspace"))).toBe(CONNECTION_REFUSAL);
    expect(await refusal(client.addCollaborator(NELL.id, { gadgetId: GADGET })))
        .toBe(CONNECTION_REFUSAL);
    expect(await collaborators(ws)).toEqual([]);
    // An account that does not exist is answered as it always is.
    expect(await client.addCollaborator("nobody@example.test", "workspace")).toBeNull();

    expect(await client.addCollaborator(GRACE.id, "workspace")).toMatchObject(
        { profile: { id: GRACE.id }, access: { role: "build" } });
    expect(await collaborators(ws)).toEqual([GRACE.id]);
  }));

  it("admits a second admin until they are one no longer", () => withWorkspace(async ws => {
    await share(ws, GRACE);
    // The admission gate passes and the workspace goes on to verify her (see the file's header).
    expect(await opening(ws, GRACE)).toBe("admitted");
    expect(ws.verified).toEqual([GRACE.id]);
    let choices = chooseAccounts(ws, GRACE);
    expect(await readsChatState(ws, GRACE)).toBe(true);
    expect(await chatHeadRecipients(ws, 20)).toEqual([userIdOf(GRACE)]);

    ws.env.ADMINS = [ADMIN.id];
    ws.verified.length = 0;
    expect(await opening(ws, GRACE)).toBe(DENIED);
    expect(ws.verified).toEqual([]);
    expect(await readsChatState(ws, GRACE)).toBe(false);
    expect(await chatHeadRecipients(ws, 21)).toEqual([]);
    // What she chose is kept: the rule reads who is an admin, and stores nothing.
    expect(ws.impl.storage.observers.get(GRACE.id)).toEqual(choices);
    expect(await collaborators(ws)).toEqual([GRACE.id]);

    ws.env.ADMINS = [ADMIN.id, GRACE.id];
    expect(await opening(ws, GRACE)).toBe("admitted");
    expect(await readsChatState(ws, GRACE)).toBe(true);
  }));

  it("answers a collaborator who is not an admin, for a report that names it, as a stranger",
      () => withWorkspace(async ws => {
    await share(ws, NELL);
    await share(ws, GRACE);
    for (let context of [{}, { chatId: CHAT_ID }, { gadgetId: GADGET },
        { chatId: CHAT_ID + 1 }]) {
      expect(await reportContext(ws, NELL, context)).toBe("refused");
      expect(await reportContext(ws, MAYA, context)).toBe("refused");
    }
    expect(await reportContext(ws, GRACE, { chatId: CHAT_ID })).toEqual({ owner: false });
    expect(await reportContext(ws, GRACE, { gadgetId: GADGET })).toEqual({ owner: false });
    expect(await reportContext(ws, ws.owner, { chatId: CHAT_ID })).toEqual({ owner: true });
  }));

  it("is added by the workspace's owner alone, while they are an admin",
      () => withWorkspace(async ws => {
    await share(ws, GRACE);
    const connections = () => [...ws.impl.storage.gatekeepers.list()].length;
    {
      // Another admin holds an account of her own, and every call would still be the owner's.
      using theirs = await open(ws, GRACE);
      expect(await refusal(theirs.newGatekeeper(1, RESOURCE_URL)))
          .toBe("Only this workspace's owner can add the admin connection.");
    }
    using client = await open(ws, ws.owner);
    ws.env.ADMINS = [GRACE.id];
    expect(await refusal(client.newGatekeeper(1, RESOURCE_URL))).toBe(NOT_ADMIN_MESSAGE);
    expect(connections()).toBe(0);
    expect(ws.impl.adminsOnly()).toBeUndefined();

    ws.env.ADMINS = [ADMIN.id, GRACE.id];
    expect(await refusal(client.newGatekeeper(1, RESOURCE_URL))).toBeUndefined();
    expect(connections()).toBe(1);
    expect(ws.impl.adminsOnly()).toBe("connection");
  }, { connection: false }));

  it("lets an admin who collaborates decide its actions, which stay the owner's",
      () => withWorkspace(async ws => {
    await share(ws, GRACE);
    let report = await ws.impl.issueReports.getByName("").submit(
        NELL, { text: "The export button does nothing.", priority: "medium" }, false);
    let id = await queueAction(ws, 1, "issueReportNote",
        [{ method: "addIssueReportEntry", args: [report.id, "A note.", "admins"] }]);
    {
      using theirs = await open(ws, GRACE);
      await theirs.approveAction(id);
    }
    expect(ws.impl.storage.actions.get(id)).toMatchObject(
        { state: "approved", resolvedBy: { id: GRACE.id } });
    let { entries } = await ws.impl.issueReports.getByName("").get(report.id);
    expect(entries).toMatchObject([{
      visibility: "admins", text: "A note.", author: { id: ADMIN.id }, via: "gatekeeper",
    }]);
  }));
});

// Narrows NELL's access from two gadgets to one, as the owner does, and returns whose index of the
// workspace's outputs was refreshed for it.
async function outputsRefreshedOnNarrowing(ws: Workspace): Promise<string[]> {
  ws.impl.storage.gadgets.put({ ...ws.impl.storage.gadgets.get(GADGET), id: GADGET + 1,
      bindingName: "NOTES" });
  await share(ws, NELL, { gadgetId: GADGET });
  await share(ws, NELL, { gadgetId: GADGET + 1 });
  let affected = (await ws.impl.getSharingManager()).removeCollaborator(
      { profileId: ws.owner.id, isOwner: true }, NELL.id, [], GADGET + 1);
  expect(affected).toMatchObject([{ profile: { id: NELL.id }, newAccess: { role: "use" } }]);
  ws.outputs.length = 0;
  await ws.impl.refreshAffectedCollaboratorListings(affected);
  return ws.outputs;
}

describe("a collaborator whose access narrows", () => {
  it("is sent the outputs they still hold", () => withWorkspace(async ws => {
    expect(await outputsRefreshedOnNarrowing(ws)).toEqual([userIdOf(NELL)]);
  }, { connection: false }));

  it("is sent nothing by a workspace that does not admit them", () => withWorkspace(async ws => {
    expect(await outputsRefreshedOnNarrowing(ws)).toEqual([]);
  }));
});

// Whether `user`, a collaborator in the sharing list, is refused at every gate.
async function refusedEverywhere(ws: Workspace, user: AiChatAuthorInfo): Promise<boolean> {
  let account = ws.impl.users.get(userIdOf(user));
  let answers = [
    await opening(ws, user) === DENIED,
    await ws.impl.authorizeCollaborator(user.id, account) === null,
    await ws.impl.authorizeGadget(user.id, account, GADGET) === false,
    await readsChatState(ws, user) === false,
    await reportContext(ws, user, { chatId: CHAT_ID }) === "refused",
  ];
  expect(new Set(answers).size).toBe(1);
  return answers[0]!;
}

describe("removing the admin connection", () => {
  it("restores ordinary sharing in a workspace that read nothing through the whole binding",
      () => withWorkspace(async ws => {
    await share(ws, NELL);
    chooseAccounts(ws, NELL);
    // What a session limited to one report reads of an ordinary report, and a queued action.
    await observe(ws, { subresources: [REPORT_SUBRESOURCE] });
    await observe(ws, {});
    await queueAction(ws, 1, "issueReportStatus");
    expect(marks(ws)).toEqual({ restricted: false, adminReads: false, adminsOnly: "connection" });
    expect(await refusedEverywhere(ws, NELL)).toBe(true);

    await removeConnection(ws);
    expect(marks(ws)).toEqual({ restricted: false, adminReads: false, adminsOnly: undefined });
    expect(await refusedEverywhere(ws, NELL)).toBe(false);
    using client = await open(ws, ws.owner);
    expect(await client.addCollaborator(MAYA.id, "workspace")).toMatchObject(
        { profile: { id: MAYA.id } });
    expect(await collaborators(ws)).toEqual([MAYA.id, NELL.id].toSorted());
  }));

  it("lifts nothing in a workspace that read through the whole binding, for good", async () => {
    let workspaceId = "";
    await withWorkspace(async ws => {
      workspaceId = ws.id;
      await share(ws, NELL);
      await share(ws, GRACE);
      chooseAccounts(ws, NELL);
      await observe(
          ws, { containsRestrictedData: true, subresources: [ADMIN_BINDING_SUBRESOURCE] });
      expect(marks(ws)).toEqual({ restricted: true, adminReads: true, adminsOnly: "reads" });

      let key: string;
      {
        using client = await open(ws, ws.owner);
        ({ key } = await client.createShareLink("workspace"));
      }
      await removeConnection(ws);
      expect(ws.impl.hasAdminConnection()).toBe(false);
      expect(marks(ws)).toEqual({ restricted: true, adminReads: true, adminsOnly: "reads" });

      // The collaborator kept in the sharing list is refused as before, and nobody joins her.
      expect(await refusedEverywhere(ws, NELL)).toBe(true);
      expect(await collaborators(ws)).toEqual([GRACE.id, NELL.id].toSorted());
      expect(await opening(ws, MAYA, key)).toBe(DENIED);
      using client = await open(ws, ws.owner);
      expect(await refusal(client.addCollaborator(MAYA.id, "workspace"))).toBe(READS_REFUSAL);
      expect(await collaborators(ws)).toEqual([GRACE.id, NELL.id].toSorted());
      // Another admin is still admitted, and still answered.
      expect(await opening(ws, GRACE)).toBe("admitted");
      expect(await reportContext(ws, GRACE, { chatId: CHAT_ID })).toEqual({ owner: false });
      // Removing every chat lifts nothing either.
      let chats: { id: number }[] = Array.from(ws.impl.storage.chatMeta.list());
      for (let chat of chats) ws.impl.storage.chatMeta.delete(chat.id);
      expect(ws.impl.adminsOnly()).toBe("reads");
    });

    // A restart of the object changes none of it: the mark is stored.
    let stub = env.TEST_OVERSEER.get(env.TEST_OVERSEER.idFromString(workspaceId));
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.env = { ...env, ADMINS: [ADMIN.id, GRACE.id] };
      expect(impl.storage.adminReads.get()).toBe(true);
      expect(impl.hasAdminConnection()).toBe(false);
      expect(impl.adminsOnly()).toBe("reads");
      expect(impl.admitsNonOwner(NELL.id)).toBe(false);
      expect(impl.admitsNonOwner(GRACE.id)).toBe(true);
    });
  });

  it("keeps one mark: restricted data of another vendor closes the workspace to nobody",
      () => withWorkspace(async ws => {
    await share(ws, NELL);
    let other = await ws.impl.addGatekeeper(
        ws.impl.ctx.exports.FakeAdminGatekeeper({ props: {} }),
        { type: "gatekeeper", vendorId: "othervendor", resourceUrl: "https://other.example/",
          typeUrlPattern: "https://other.example/" },
        ws.impl.ownerId, undefined, undefined, ws.owner);
    let otherId: number = await other.getId();
    // The id the admin gatekeeper names means nothing on another vendor's observation.
    await observe(ws, { containsRestrictedData: true, subresources: [ADMIN_BINDING_SUBRESOURCE] },
        otherId);
    expect(marks(ws)).toEqual({ restricted: true, adminReads: false, adminsOnly: "connection" });

    // With the unread admin connection gone, the workspace is shared as any other is.
    await removeConnection(ws);
    expect(marks(ws)).toEqual({ restricted: true, adminReads: false, adminsOnly: undefined });
    expect(await opening(ws, NELL)).toBe("admitted");
    using client = await open(ws, ws.owner);
    expect(await client.addCollaborator(MAYA.id, "workspace")).toMatchObject(
        { profile: { id: MAYA.id } });
  }));

  it("restores ordinary sharing in a workspace a report session marked as restricted",
      () => withWorkspace(async ws => {
    await share(ws, NELL);
    // What a report session reads of a reporter's workspace that itself holds restricted data.
    await observe(ws, { containsRestrictedData: true, subresources: [REPORT_SUBRESOURCE] });
    expect(marks(ws)).toEqual({ restricted: true, adminReads: false, adminsOnly: "connection" });

    // The latch holds: a rule applies nothing from here on.
    ws.impl.storage.autoApproveTags.put({
      gatekeeperId: ws.gatekeeperId, actionKind: ADMIN_AGENT_ACTIONS.issueReportNote.kind,
      enabledBy: ADMIN,
    });
    let id = await queueAction(ws, 1, "issueReportNote");
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);
    expect(ws.impl.storage.actions.get(id).state).toBe("pending");

    await removeConnection(ws);
    expect(marks(ws)).toEqual({ restricted: true, adminReads: false, adminsOnly: undefined });
    expect(await opening(ws, NELL)).toBe("admitted");
    using client = await open(ws, ws.owner);
    expect(await client.addCollaborator(MAYA.id, "workspace")).toMatchObject(
        { profile: { id: MAYA.id } });
  }));

  // The whole binding's id is the one subresource the workspace reads, and only on an observation
  // of the admin connection that says its read holds restricted data.
  it.each([
    { claims: { containsRestrictedData: true, subresources: [ADMIN_BINDING_SUBRESOURCE] },
      restricted: true, adminReads: true },
    { claims: { containsRestrictedData: true, subresources: [REPORT_SUBRESOURCE] },
      restricted: true, adminReads: false },
    { claims: { containsRestrictedData: true, subresources: [] },
      restricted: true, adminReads: false },
    { claims: { containsRestrictedData: true }, restricted: true, adminReads: false },
    // A hook's delivery: the whole binding's id, and nothing read.
    { claims: { subresources: [ADMIN_BINDING_SUBRESOURCE] }, restricted: false, adminReads: false },
  ])("marks an observation that claims $claims as restricted: $restricted, admin reads: " +
      "$adminReads", ({ claims, restricted, adminReads }) => withWorkspace(async ws => {
    await observe(ws, claims);
    expect(marks(ws)).toEqual(
        { restricted, adminReads, adminsOnly: adminReads ? "reads" : "connection" });
  }));
});
