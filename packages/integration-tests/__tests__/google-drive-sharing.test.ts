// Sharing and moving Drive files through the real Workshop and the real Google gatekeeper, with
// only Google itself faked (google-fake.ts). A share queued on a read and write Drive connection
// shows as pending in the file's access list and reaches Google only once it is approved. A move
// is not simulated: the agent's turn waits for the decision, and the file moves when it is
// approved. What Google refuses under an organization's sharing rule reaches the approver with
// Google's reason code, and the action stays pending until it is rejected. A sharing listing
// reports the file it read, `drive/file/<id>`, and nothing else, so the kernel admits every
// collaborator whose own Google account can open the file, whether or not Google would show them
// its sharing, and no collaborator who cannot open it (docs/observers.md).

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuthenticatedApi, Overseer } from "@gadgets/workshop-shared/api";
import { startHarness, type Harness } from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, type ChatCompletionStep, type RoutedScriptedModel,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, MAX_OBSERVER_PROMPTS, nextUsernames, ObserverConfigRecorder, signUp, stubFor, waitFor,
  waitForIdleChat, type ConnectedAccount,
} from "../src/rpc-client.js";
import { FakeGoogle, googleGatekeeper } from "./google-fake.js";

const google = new FakeGoogle();
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler, google.handler] });
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [googleGatekeeper()], enableGadgetExecution: true });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

/** The gatekeeper's Drive writes grant, which a read and write connection's account must hold. */
const WRITES = "https://drive.google.com/drive/writes";

/** The resource URL of a read-only connection to Drive file `id`. */
const fileUrl = (id: string) => `https://drive.google.com/file/d/${id}/view`;

/** The resource URL of a read-only connection to Drive folder `id`. */
const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`;

type GoogleUser = Disposable & {
  username: string;
  api: RpcStub<AuthenticatedApi>;
  account: ConnectedAccount;
};

/** A fresh Workshop user who has connected the Google account whose OAuth code is their username. */
async function googleUser(prefix: string): Promise<GoogleUser> {
  using stack = new DisposableStack();
  const [username] = nextUsernames(prefix);
  if (!username) throw new Error("No username was issued");
  const api = stack.use(await signUp(stack.use(connect(harness.url)), username));
  const account = await google.connect(harness, api, username);
  return Object.assign(stack.move(), { username, api, account });
}

type OwnerWorkspace = Disposable & {
  ws: RpcStub<Overseer>;
  workspaceId: string;
  /** Each connection's ID, by the name it is bound under. */
  connectionIds: Map<string, number>;
  model: RoutedScriptedModel;
};

/**
 * `owner`'s workspace with each `[name, resourceUrl]` of `connections` connected through their
 * account and bound under `name` to a gadget, so the workspace's chats get it too; the agent
 * follows `steps`.
 */
async function bound(owner: GoogleUser, steps: ChatCompletionStep[], connections: [string, string][])
    : Promise<OwnerWorkspace> {
  using stack = new DisposableStack();
  const model = models.script(steps);
  await owner.api.addModel(model.userModel.profile, model.userModel.config);
  const ws = stack.use(await owner.api.newWorkspace());
  const { id: workspaceId } = await ws.getMetadata();
  using reader = await ws.createGadget("Reader", undefined, "READER");
  const connectionIds = new Map<string, number>();
  for (const [name, resourceUrl] of connections) {
    const connection = await ws.newGatekeeper(owner.account.id, resourceUrl);
    if (!connection) throw new Error(`Failed to connect ${resourceUrl}`);
    stack.use(connection);
    // Bound before any chat opens: a permanent edge seeds a new chat's env under its name.
    const connectionId = await connection.getId();
    connectionIds.set(name, connectionId);
    await reader.bind(name, connectionId);
  }
  return Object.assign(stack.move(), { ws, workspaceId, connectionIds, model });
}

/** `collaborator` opens the workspace, choosing their own Google account at every prompt. */
async function opens(collaborator: GoogleUser, workspaceId: string)
    : Promise<{ recorder: ObserverConfigRecorder; error?: Error }> {
  const recorder = new ObserverConfigRecorder()
    .alwaysChoose(collaborator.account.id, MAX_OBSERVER_PROMPTS);
  using callback = stubFor(recorder);
  try {
    (await collaborator.api.openWorkspace(workspaceId, undefined, callback))[Symbol.dispose]();
    return { recorder };
  } catch (error) {
    return { recorder, error: error as Error };
  }
}

/** One step of the agent: tool call `id`, which runs `body` as the code of an `executeCode` call. */
const runs = (id: string, body: string): ChatCompletionStep => ({
  toolCall: { id, name: "executeCode", arguments: {
    code: `export default async function(self, env) {\n${body}\n}`,
  } },
});

/** What the code of tool call `id` returned, as the agent's `nth` model request carries it. */
function returned(model: RoutedScriptedModel, nth: number, id: string): string {
  const { messages } = model.requests[nth] as {
    messages: { role: string; tool_call_id?: string; content?: unknown }[];
  };
  const result = messages.find(message => message.role === "tool" && message.tool_call_id === id);
  const prefix = "Return value: ";
  if (typeof result?.content !== "string" || !result.content.startsWith(prefix)) {
    throw new Error(`Tool call ${id} returned no value`);
  }
  return result.content.slice(prefix.length);
}

/** The one action pending in workspace `ws`. */
async function pendingAction(ws: RpcStub<Overseer>) {
  const { entries } = await ws.listActions({ filter: "pending" });
  expect(entries).toHaveLength(1);
  const [entry] = entries;
  if (!entry) throw new Error("No action is pending");
  return entry;
}

/** The message approving action `id` of workspace `ws` fails with. */
async function approvalRefusal(ws: RpcStub<Overseer>, id: number): Promise<string> {
  try {
    await ws.approveAction(id);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`Action ${id} was applied`);
}

it.concurrent("a share is shown pending, reaches Google only when approved, and can be seen there",
    async () => {
  using owner = await googleUser("driveshareowner");
  const fileId = `doc-${owner.username}`;
  google.driveFile(fileId);
  // The account allows changes: Google is asked for the grant's scope, and grants it.
  await google.grant(harness, owner.api, owner.account, owner.username, [WRITES]);

  const file = JSON.stringify(fileId);
  // An address outside the owner's own domain, which is example.com.
  const address = "bob@partner.example";
  // The agent shares the file, then lists who it is shared with.
  using state = await bound(owner, [
    runs("share", `  const pending = await env.DRIVE.share(${file}, { type: "user", emailAddress: ${
      JSON.stringify(address)} }, "reader", { notify: false });
  const listed = await env.DRIVE.listAccess(${file});
  return JSON.stringify({ pending, listed });`),
    { text: "Shared." },
  ], [["DRIVE", `${fileUrl(fileId)}?access=write`]]);
  const { ws, model } = state;

  const chatId = await ws.newChat("Share the file.", SCRIPTED_MODEL_ID);
  await waitFor("the sharing turn", async () => model.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);
  expect(model.remainingSteps()).toBe(0);
  // The share is answered with its pending entry, which the listing made after it ends with.
  const { pending, listed } = JSON.parse(returned(model, 1, "share")) as {
    pending: Record<string, unknown>; listed: unknown[];
  };
  expect(pending).toMatchObject({
    id: expect.stringMatching(/^pending:/), pending: true, emailAddress: address,
  });
  expect(listed.at(-1)).toEqual(pending);

  // Nothing has reached Google: the share waits for approval.
  const post = `POST www.googleapis.com/drive/v3/files/${fileId}/permissions`;
  expect(google.drivePermissions(fileId)).toEqual([]);
  expect(google.requests).not.toContain(post);
  const entry = await pendingAction(ws);
  // The approver is told first that the address is outside the account's own domain.
  expect(entry.description).toMatchObject({
    title: "Outside address: share a Google Drive file with a person",
    actionKind: { tag: "driveSharing", label: "Drive sharing" },
    autoApprovable: false,
    description: expect.stringMatching(/^\*\*This address is outside/),
    fields: expect.arrayContaining([{ label: "Share with", kind: "inline", value: address }]),
  });

  // Approved, it is given once, as Google holds it.
  await ws.approveAction(entry.id);
  await waitFor("the share to reach Google", async () =>
    google.drivePermissions(fileId).length > 0 || null);
  expect(google.drivePermissions(fileId)).toEqual([
    expect.objectContaining({ type: "user", role: "reader", emailAddress: address }),
  ]);
  expect(google.requests.filter(request => request === post)).toHaveLength(1);
});

it.concurrent("a move waits for its approval and then lands", async () => {
  using owner = await googleUser("drivemoveowner");
  const rootId = `folder-${owner.username}`;
  const childId = `archive-${owner.username}`;
  const fileId = `doc-${owner.username}`;
  google.driveFolder(rootId);
  google.driveFolder(childId, { parent: rootId });
  google.driveFile(fileId, { parent: rootId });
  // Without the grant the move would be refused when it is queued.
  await google.grant(harness, owner.api, owner.account, owner.username, [WRITES]);

  // The agent moves the file into the child folder.
  using state = await bound(owner, [
    runs("move", `  await env.DRIVE.move(${JSON.stringify(fileId)}, ${JSON.stringify(childId)});
  return "queued";`),
    { text: "Moved." },
  ], [["DRIVE", `${folderUrl(rootId)}?access=write`]]);
  const { ws, model } = state;

  const chatId = await ws.newChat("File it in the archive.", SCRIPTED_MODEL_ID);
  const entry = await waitFor("the move to be queued", async () => {
    const { entries } = await ws.listActions({ filter: "pending" });
    return entries[0] ?? null;
  });
  expect(entry.description).toMatchObject({
    title: "Move a Google Drive file", awaitDecision: true, autoApprovable: false,
  });
  // The move is not simulated: the file is where it was, and the turn waits for the decision
  // without asking the model anything more.
  await waitForIdleChat(ws, chatId);
  expect((await ws.listActions({ filter: "pending" })).entries).toHaveLength(1);
  expect(google.driveParent(fileId)).toBe(rootId);
  expect(model.requests).toHaveLength(1);
  expect(model.remainingSteps()).toBe(1);

  // Approved, the file is in the child folder, and the turn goes on from the move's result.
  await ws.approveAction(entry.id);
  await waitFor("the move to reach Google", async () =>
    google.driveParent(fileId) === childId || null);
  await waitFor("the turn to resume", async () => model.requests.length === 2 || null);
  expect(returned(model, 1, "move")).toBe("queued");
  await waitForIdleChat(ws, chatId);
  expect(model.remainingSteps()).toBe(0);
});

it.concurrent("an organization's refusal reaches the approver with Google's reason", async () => {
  using owner = await googleUser("driverefusedowner");
  const fileId = `doc-${owner.username}`;
  google.driveFile(fileId);
  await google.grant(harness, owner.api, owner.account, owner.username, [WRITES]);
  // This owner's organization, and no other account's, keeps sharing inside example.com.
  google.forbidSharingOutside(owner.username, "example.com");

  // The agent shares the file with an address at another domain.
  using state = await bound(owner, [
    runs("share", `  const pending = await env.DRIVE.share(${JSON.stringify(fileId)
      }, { type: "user", emailAddress: "erin@partner.example" }, "reader", { notify: false });
  return pending.id;`),
    { text: "Shared." },
  ], [["DRIVE", `${fileUrl(fileId)}?access=write`]]);
  const { ws, model } = state;

  const chatId = await ws.newChat("Share the file.", SCRIPTED_MODEL_ID);
  await waitFor("the sharing turn", async () => model.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);
  const entry = await pendingAction(ws);

  // Google refuses the approved share, and the approver is told why, with Google's own code.
  const post = `POST www.googleapis.com/drive/v3/files/${fileId}/permissions`;
  const refusal = await approvalRefusal(ws, entry.id);
  expect(refusal)
    .toContain("Your organization does not allow sharing this outside the organization.");
  expect(refusal).toContain("[http=403 reason=shareOutNotPermitted]");
  expect(google.drivePermissions(fileId)).toEqual([]);
  expect(google.requests.filter(request => request === post)).toHaveLength(1);

  // The Workshop's action log has no failed state, so the action is still pending there. Approved
  // again, it is answered from what the gatekeeper stored, and Google is not asked a second time.
  expect((await pendingAction(ws)).id).toBe(entry.id);
  expect(await approvalRefusal(ws, entry.id)).toBe(refusal);
  expect(google.requests.filter(request => request === post)).toHaveLength(1);

  // Rejecting it clears it.
  await ws.rejectAction(entry.id);
  expect((await ws.listActions({ filter: "pending" })).entries).toEqual([]);
});

it.concurrent("a collaborator who can open a file sees its sharing in a shared workspace, whether or not they can share it",
    async () => {
  using owner = await googleUser("driveaccessowner");
  using carol = await googleUser("driveaccesscarol");
  using dave = await googleUser("driveaccessdave");
  const fileId = `doc-${owner.username}`;
  // Only the owner can share the file: Carol can open it, and Dave cannot see it.
  google.driveFile(fileId, { sharers: [owner.username], hidden: [dave.username] });
  await google.grant(harness, owner.api, owner.account, owner.username, [WRITES]);

  // All of Drive, read and write. An account binding on purpose: a file binding's own admission
  // check would refuse Dave for the bound file, before what the listing reported is asked about.
  using state = await bound(owner, [
    runs("list", `  return JSON.stringify(await env.DRIVE.listAccess(${JSON.stringify(fileId)}));`),
    { text: "Read." },
  ], [["DRIVE", "https://drive.google.com/drive/my-drive?access=write"]]);
  const { ws, workspaceId, connectionIds, model } = state;
  const connectionId = connectionIds.get("DRIVE");
  if (connectionId === undefined) throw new Error("DRIVE is not connected");

  // The agent lists who the file is shared with. It is shared with nobody, and the empty listing
  // still reports the file.
  const chatId = await ws.newChat("Read who the file is shared with.", SCRIPTED_MODEL_ID);
  await waitFor("the listing turn", async () => model.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);
  expect(model.remainingSteps()).toBe(0);
  expect(returned(model, 1, "list")).toBe("[]");
  const { entries: observations } = await ws.listActions({ filter: "observation" });
  expect(observations.map(entry => entry.description.title)).toContain("Read Google Drive sharing");

  // Carol can open the file and not share it, so Google itself would refuse her its permission
  // list. She is admitted, checked with her own token: the file is all the listing requires.
  await ws.addCollaborator(carol.username, "workspace");
  const admitted = await opens(carol, workspaceId);
  expect(admitted.error).toBeUndefined();
  expect(google.driveLookups).toContain(`${carol.username} ${fileId}`);

  // Dave holds a Drive grant and cannot open the file, so he is refused, at this connection.
  await ws.addCollaborator(dave.username, "workspace");
  const refused = await opens(dave, workspaceId);
  expect(refused.error).toBeDefined();
  expect(refused.recorder.calls.at(-1)?.filter(need => need.failure)).toEqual([
    expect.objectContaining({ gatekeeperId: connectionId }),
  ]);
  expect(google.driveLookups).toContain(`${dave.username} ${fileId}`);
});

/** Ask the fake, as the Google account of OAuth code `code`, for `method` on Drive's `path`. */
async function askDrive(code: string, method: string, path: string, body?: unknown): Promise<Response> {
  const request = new Request(`https://www.googleapis.com/drive/v3/${path}`, {
    method,
    headers: { Authorization: `Bearer token-${code}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = await google.handler(new URL(request.url), request.method, request.headers, request);
  if (!response) throw new Error(`The fake declined ${method} ${path}`);
  return response;
}

/** The status of Drive's answer `response`, and the reason its error body names. */
async function driveRefusal(response: Response) {
  const { error } = await response.json() as { error: { errors: { reason: string }[] } };
  return { status: response.status, reason: error.errors[0]?.reason };
}

/** What Drive's answer `response` lists a permission as: its ID, its role, and each detail's. */
async function listedAs(response: Response) {
  const { id, role, permissionDetails } = await response.json() as {
    id: string; role: string; permissionDetails: { role: string; inherited: boolean }[];
  };
  return {
    status: response.status, id, role,
    details: permissionDetails.map(detail => `${detail.role}${detail.inherited ? " inherited" : ""}`),
  };
}

// The fake itself, asked directly, for what no test above reaches: the gatekeeper holds Google's
// answers to what an approval described, so what the fake does with a permission that exists, with
// access a folder gives, and with a move, has to be what Google was seen to do.
it("Google's fake gives, changes and removes access as Google does, for an account that can share the file",
    async () => {
  const [code] = nextUsernames("drivefakesharer");
  if (!code) throw new Error("No username was issued");
  const viewer = `${code}-viewer`;
  const folderId = `folder-${code}`;
  const fileId = `doc-${code}`;
  google.driveFolder(folderId);
  google.driveFile(fileId, { parent: folderId, sharers: [code], hidden: [`${code}-hidden`] });
  const permissions = `files/${fileId}/permissions`;
  const bob = { type: "user", emailAddress: "bob@partner.example" };
  const bobsId = "perm-bob-partner-example";
  const give = (path: string, grant: object, query = "fields=id") =>
    askDrive(code, "POST", `${path}?${query}`, grant);

  // The account is told by its permission ID, and what it may do by the file's capabilities.
  expect(await (await askDrive(code, "GET", "about?fields=user")).json()).toEqual({
    user: { permissionId: `perm-${code}`, emailAddress: `${code}@example.com` },
  });
  expect(await (await askDrive(code, "GET", `files/${fileId}?fields=id`)).json()).toMatchObject({
    parents: [folderId], capabilities: { canShare: true, canMoveItemWithinDrive: true },
  });
  expect(await (await askDrive(viewer, "GET", `files/${fileId}?fields=id`)).json()).toMatchObject({
    capabilities: { canShare: false, canMoveItemWithinDrive: false },
  });
  const root = await (await askDrive(code, "GET", "files/root?fields=id")).json();
  expect(root).toMatchObject({ id: `my-drive-${code}`, capabilities: { canAddChildren: true } });
  expect(root).not.toHaveProperty("parents");

  // An account that cannot share the file is refused its sharing, and one that cannot see it is
  // told only that.
  for (const [method, path] of [
    ["GET", permissions], ["POST", `${permissions}?fields=id`], ["PATCH", `${permissions}/${bobsId}`],
    ["DELETE", `${permissions}/${bobsId}`],
  ] as const) {
    expect(await driveRefusal(await askDrive(viewer, method, path, method === "GET" ? undefined : bob)),
      `${method} as an account that cannot share`)
      .toEqual({ status: 403, reason: "insufficientFilePermissions" });
    expect(await driveRefusal(await askDrive(`${code}-hidden`, method, path)), `${method} unseen`)
      .toEqual({ status: 404, reason: "notFound" });
  }
  expect(await driveRefusal(await give(permissions, { ...bob, role: "reader" }, "")))
    .toEqual({ status: 400, reason: "required" });
  expect(await driveRefusal(await give(permissions, { ...bob, role: "reader" },
    "fields=id&sendNotificationEmail=false&emailMessage=Hello")))
    .toEqual({ status: 403, reason: "forbidden" });
  expect(google.drivePermissions(fileId)).toEqual([]);

  // A create only ever raises: a lower role answers the permission as it is.
  for (const [given, held] of [["commenter", "commenter"], ["reader", "commenter"], ["writer", "writer"]]) {
    expect(await listedAs(await give(permissions, { ...bob, role: given })), `given ${given}`)
      .toEqual({ status: 200, id: bobsId, role: held, details: [held] });
  }
  // A mailbox is one grantee however its address is capitalized.
  expect(await listedAs(await give(permissions,
    { type: "user", emailAddress: "Bob@Partner.Example", role: "reader" })))
    .toEqual({ status: 200, id: bobsId, role: "writer", details: ["writer"] });
  expect(google.drivePermissions(fileId)).toEqual([{ id: bobsId, ...bob, role: "writer" }]);

  // Anyone's access is one permission under two IDs: a create makes it searchable and never the
  // reverse, and either ID reaches it.
  const anyone = { type: "anyone", role: "reader" };
  expect(await listedAs(await give(permissions, anyone))).toMatchObject({ id: "anyoneWithLink" });
  expect(await listedAs(await give(permissions, { ...anyone, allowFileDiscovery: true })))
    .toMatchObject({ id: "anyone" });
  expect(await listedAs(await give(permissions, { ...anyone, role: "commenter" })))
    .toMatchObject({ id: "anyone", role: "commenter" });
  expect(await listedAs(await askDrive(code, "PATCH", `${permissions}/anyoneWithLink`, { role: "reader" })))
    .toMatchObject({ id: "anyone", role: "reader" });
  expect(google.drivePermissions(fileId)).toHaveLength(2);
  expect((await askDrive(code, "DELETE", `${permissions}/anyoneWithLink`)).status).toBe(204);
  expect(await driveRefusal(await askDrive(code, "DELETE", `${permissions}/anyone`)))
    .toEqual({ status: 404, reason: "notFound" });
  expect(await driveRefusal(await askDrive(code, "PATCH", `${permissions}/perm-nobody`, { role: "reader" })))
    .toEqual({ status: 404, reason: "notFound" });

  // What the folder gives is listed on the file as inherited: beside what the file gives the same
  // grantee, and after the file's own permissions for a grantee it gives nothing.
  const group = { type: "group", emailAddress: "team@partner.example" };
  await give(`files/${folderId}/permissions`, { ...bob, role: "commenter" });
  await give(`files/${folderId}/permissions`, { ...group, role: "reader" });
  expect(await (await askDrive(code, "GET", permissions)).json()).toEqual({ permissions: [
    {
      id: bobsId, ...bob, role: "writer", permissionDetails: [
        { permissionType: "file", role: "commenter", inherited: true },
        { permissionType: "file", role: "writer", inherited: false },
      ],
    },
    {
      id: "perm-team-partner-example", ...group, role: "reader",
      permissionDetails: [{ permissionType: "file", role: "reader", inherited: true }],
    },
  ] });
  // A create at or below what the folder gives adds nothing to the file.
  expect(await listedAs(await give(permissions, { ...group, role: "reader" })))
    .toMatchObject({ details: ["reader inherited"] });
  // Inherited access is neither lowered nor removed on the file, and a role set to exactly what the
  // folder gives leaves nothing on the file itself.
  const bobs = `${permissions}/${bobsId}`;
  expect(await driveRefusal(await askDrive(code, "PATCH", bobs, { role: "reader" })))
    .toEqual({ status: 403, reason: "cannotModifyInheritedPermission" });
  expect(await driveRefusal(await askDrive(code, "DELETE", bobs)))
    .toEqual({ status: 403, reason: "cannotDeletePermission" });
  expect(google.drivePermissions(fileId)).toHaveLength(1);
  expect(await listedAs(await askDrive(code, "PATCH", bobs, { role: "commenter" })))
    .toMatchObject({ status: 200, role: "commenter", details: ["commenter inherited"] });
  expect(google.drivePermissions(fileId)).toEqual([]);

  // An organization's rule refuses its own account's shares outside its domain, and no other's.
  google.forbidSharingOutside(code, "example.com");
  for (const grant of [bob, { type: "domain", domain: "partner.example" }]) {
    expect(await driveRefusal(await give(permissions, { ...grant, role: "reader" })))
      .toEqual({ status: 403, reason: "shareOutNotPermitted" });
  }
  expect((await give(permissions, { type: "user", emailAddress: `${viewer}@example.com`, role: "reader" }))
    .status).toBe(200);
  expect((await askDrive(viewer, "POST", `files/${folderId}/permissions?fields=id`,
    { type: "domain", domain: "partner.example", role: "reader" })).status).toBe(200);

  // An account's address and a domain name the same grantee in capitals: the account's permission
  // ID is the one Drive tells the account it has, and nothing is given a second time.
  expect(await listedAs(await give(permissions,
    { type: "user", emailAddress: `${viewer}@example.com`.toUpperCase(), role: "reader" })))
    .toMatchObject({ status: 200, id: `perm-${viewer}` });
  expect(await (await askDrive(viewer, "GET", "about?fields=user")).json())
    .toMatchObject({ user: { permissionId: `perm-${viewer}` } });
  expect(google.drivePermissions(fileId)).toHaveLength(1);
  expect(await listedAs(await askDrive(viewer, "POST", `files/${folderId}/permissions?fields=id`,
    { type: "domain", domain: "Partner.Example", role: "reader" })))
    .toMatchObject({ status: 200, id: "perm-domain-partner-example" });
  expect(google.drivePermissions(folderId).filter(permission => permission.type === "domain"))
    .toHaveLength(1);
});

it("Google's fake moves a file into a folder, once or again, for an account that can move it", async () => {
  const [code] = nextUsernames("drivefakemover");
  if (!code) throw new Error("No username was issued");
  const [fromId, toId, innerId, fileId, otherId] =
    ["from", "to", "inner", "doc", "other"].map(name => `${name}-${code}`);
  if (!fromId || !toId || !innerId || !fileId || !otherId) throw new Error("No file ID was made");
  google.driveFolder(fromId);
  google.driveFolder(toId);
  google.driveFolder(innerId, { parent: toId });
  google.driveFile(fileId, { parent: fromId, sharers: [code], hidden: [`${code}-hidden`] });
  google.driveFile(otherId, { parent: fromId });
  const move = (as: string, file: string, to: string) =>
    askDrive(as, "PATCH", `files/${file}?addParents=${to}&removeParents=${fromId}&fields=id,parents`, {});

  expect(await driveRefusal(await move(`${code}-viewer`, fileId, toId)))
    .toEqual({ status: 403, reason: "insufficientFilePermissions" });
  expect(await driveRefusal(await move(`${code}-hidden`, fileId, toId)))
    .toEqual({ status: 404, reason: "notFound" });
  expect(await driveRefusal(await move(code, `missing-${code}`, toId)))
    .toEqual({ status: 404, reason: "notFound" });
  expect(await driveRefusal(await move(code, fileId, `missing-${code}`)))
    .toEqual({ status: 404, reason: "notFound" });
  expect(await driveRefusal(await move(code, fileId, otherId)))
    .toEqual({ status: 403, reason: "parentNotAFolder" });
  expect(google.driveParent(fileId)).toBe(fromId);
  // A folder goes neither into itself nor into a folder inside it, and stays where it was.
  for (const inside of [toId, innerId]) {
    expect(await driveRefusal(await move(code, toId, inside)), `into ${inside}`)
      .toEqual({ status: 400, reason: "badRequest" });
  }
  expect(google.driveParent(toId)).toBeUndefined();
  expect(google.driveParent(innerId)).toBe(toId);

  // The move, and the same move again, which names a folder the file has left.
  for (const attempt of ["first", "repeated"]) {
    const moved = await move(code, fileId, toId);
    expect(await moved.json(), attempt).toEqual({ id: fileId, parents: [toId] });
    expect(google.driveParent(fileId), attempt).toBe(toId);
  }
  // Only a lookup is one: no move was recorded as a read of the file.
  expect(google.driveLookups.filter(lookup => lookup.endsWith(fileId))).toEqual([]);
});
