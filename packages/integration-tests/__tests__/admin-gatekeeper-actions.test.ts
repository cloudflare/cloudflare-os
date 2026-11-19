import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ADMIN_AGENT_ACTIONS } from "@gadgets/workshop-shared/admin-agent";
import { ADMIN_GRANT_ERROR_CODES, type AdminApi, type Overseer } from "@gadgets/workshop-shared/api";
import type { Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import type { ConnectedAccount } from "../src/rpc-client.js";
import {
  addAdminConnection, adminApiOf, agentTurn, approveContent, isRestricted, listed, newMember,
  newUser, newWorkspace, OWNER, pendingActions, provisionAdminAccount, requestsFiled, settle,
  startAdminHarness, turnModels, VENDOR, writesMade, type AdminConnection, type Suite,
  type SuiteUser,
} from "./admin-gatekeeper-harness.js";

// The gatekeeper's two action kinds, a write to a workspace and a request for its content: each
// waits for a person, and runs once approved as the workspace owner's one call.
//
// The audit log and the content requests are deployment-wide, so this file owns its harness and
// runs serially.
const models = turnModels();
const network = new NetworkInterceptor({ handlers: [models.handler] });
const scope = new DisposableStack();
let harness: Harness;
let suite: Suite;
let owner: SuiteUser;
let admin: RpcStub<AdminApi>;
let ownerAccount: ConnectedAccount;

beforeAll(async () => {
  network.install();
  harness = await startAdminHarness();
  suite = { harness, models, scope };
  owner = await newUser(suite, OWNER);
  admin = await adminApiOf(suite, owner);
  await admin.setGatekeeperMode(VENDOR, "optional");
  await admin.setAdminWorkspaceAccess("content");
  ownerAccount = await provisionAdminAccount(owner);
});

afterAll(async () => {
  try {
    scope.dispose();
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

const { secondAdminRequired } = ADMIN_GRANT_ERROR_CODES;
const json = JSON.stringify;

type Triage = { ws: RpcStub<Overseer>; id: string; connection: AdminConnection };

/** A workspace of the owner with the admin connection. */
async function triageWorkspace(title: string): Promise<Triage> {
  const { ws, id } = await newWorkspace(suite, owner, title);
  const connection = await addAdminConnection(ws, ownerAccount.id);
  expect(await isRestricted(ws)).toBe(false);
  return { ws, id, connection };
}

/** Code that calls `call` on the admin binding and records how it ends under `name`. */
const attempt = (name: string, call: string) => `await attempt(${json(name)}, () => ${call});`;

it("holds a write for a person, and runs it once approved; and holds a " +
    "request for content for a person who may then not approve it", async () => {
  const wanted = await newMember(suite, "target");
  const theirs = await newWorkspace(suite, wanted, "Target");
  await listed(admin, wanted.name, theirs.id);
  const { ws, id, connection } = await triageWorkspace("Triage, requests");
  const reason = "The owner asked us to look";

  const restart = await agentTurn(owner, ws, attempt("write", `env.ADMIN.writeWorkspace(
      ${json(theirs.id)}, "restartWorkspace", {}, ${json(reason)})`), { connection });
  await settle(ws);
  expect(restart.paused()).toBe(true);
  const [write] = await pendingActions(ws, 1);
  expect(write).toMatchObject({ description: {
    title: `Write to workspace ${theirs.id}: restartWorkspace`,
    autoApprovable: false,
    actionKind: ADMIN_AGENT_ACTIONS.workspaceWriteRequest.kind,
  } });
  expect(await writesMade(admin, theirs.id, id)).toEqual([]);

  await ws.approveAction(write!.id);
  expect(await restart.resumed()).toEqual({ write: { value: null } });
  expect(await writesMade(admin, theirs.id, id)).toEqual([expect.objectContaining({
    method: "restartWorkspace", admin: OWNER, via: "gatekeeper", reason,
    agent: { workspaceId: id, chatId: restart.chatId },
  })]);

  const content = await agentTurn(owner, ws, attempt("request", `env.ADMIN.requestContentAccess(
      ${json(theirs.id)}, ${json(reason)})`), { chatId: restart.chatId });
  await settle(ws);
  expect(content.paused()).toBe(true);
  const [card] = await pendingActions(ws, 1);
  expect(card).toMatchObject({ description: {
    title: `Ask the admins for access to the content of workspace ${theirs.id}`,
    autoApprovable: false,
    actionKind: ADMIN_AGENT_ACTIONS.contentAccessRequest.kind,
  } });
  // The card says who may not approve the request it files.
  expect(card!.description.description).toContain(
      "Nobody who is in this workspace now, you included once you approve this, can approve " +
      "that request.");
  expect(await requestsFiled(admin, theirs.id, id)).toEqual([]);

  await ws.approveAction(card!.id);
  expect(await content.resumed()).toEqual({ request: { value: null } });
  const [filed] = await requestsFiled(admin, theirs.id, id);
  expect(filed).toMatchObject({
    state: "pending", requestedBy: OWNER, via: "gatekeeper",
    agent: { workspaceId: id, chatId: restart.chatId },
  });
  expect(await approveContent(admin, filed!.id)).toBe(secondAdminRequired);
  expect(await isRestricted(ws)).toBe(false);
  await admin.denyContentAccess(filed!.id);
});
