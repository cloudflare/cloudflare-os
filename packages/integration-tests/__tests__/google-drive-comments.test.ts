// Drive comments through the real Workshop and the real Google gatekeeper, with only Google itself
// faked (google-fake.ts). A read-only Drive connection refuses to comment, and a read and write one,
// whose account allowed changes through the gatekeeper's own consent flow, queues a comment that
// reaches Google only once it is approved. A comment listing reports the file it read,
// `drive/file/<id>`, and the kernel checks that against each collaborator's own Google account
// (docs/observers.md): whoever can open the file is admitted, whether or not they can comment on
// it, and whoever cannot open it is not.

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

/**
 * Expect the agent's `nth` model request to carry, for tool call `id`, a result that is `content`:
 * the whole text, or a matcher of it.
 */
function expectToolResult(model: RoutedScriptedModel, nth: number, id: string, content: unknown): void {
  expect(model.requests[nth]).toMatchObject({ messages: expect.arrayContaining([
    expect.objectContaining({ role: "tool", tool_call_id: id, content }),
  ]) });
}

/** Ask the fake, as the Google account of OAuth code `code`, for `method` on `path` under Drive's files. */
async function askDrive(code: string, method: string, path: string, body?: unknown): Promise<Response | null> {
  const request = new Request(`https://www.googleapis.com/drive/v3/files/${path}`, {
    method,
    headers: { Authorization: `Bearer token-${code}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return await google.handler(new URL(request.url), request.method, request.headers, request);
}

/** The status of Drive's answer `response`, and the reason and parameter its error body names. */
async function driveRefusal(response: Response | null) {
  if (!response) throw new Error("The fake declined the request");
  const { error } = await response.json() as { error: { errors: { reason: string; location?: string }[] } };
  return { status: response.status, reason: error.errors[0]?.reason, location: error.errors[0]?.location };
}

it.concurrent("a read-only Drive connection refuses to comment, and a read and write one posts once approved",
    async () => {
  using owner = await googleUser("drivecommentowner");
  const fileId = `doc-${owner.username}`;
  google.driveFile(fileId);
  // The account allows changes: Google is asked for the grant's scope, and grants it.
  await google.grant(harness, owner.api, owner.account, owner.username, [WRITES]);

  const file = JSON.stringify(fileId);
  // The agent comments through the read-only connection, which refuses, then through the read and
  // write one, which queues the comment.
  using state = await bound(owner, [
    { toolCall: { id: "readonly", name: "executeCode", arguments: { code: `export default async function(self, env) {
  try { await env.DRIVE_RO.comment(${file}, "Looks good."); return "queued"; }
  catch (error) { return String(error.message ?? error); }
}` } } },
    { toolCall: { id: "write", name: "executeCode", arguments: { code: `export default async function(self, env) {
  const pending = await env.DRIVE_RW.comment(${file}, "Looks good.");
  return pending.id;
}` } } },
    { text: "Done." },
  ], [["DRIVE_RO", fileUrl(fileId)], ["DRIVE_RW", `${fileUrl(fileId)}?access=write`]]);
  const { ws, model } = state;

  const chatId = await ws.newChat("Comment on the file.", SCRIPTED_MODEL_ID);
  await waitFor("the comment turn", async () => model.requests.length === 3 || null);
  await waitForIdleChat(ws, chatId);
  expect(model.remainingSteps()).toBe(0);
  // The refusal names the connection to ask for instead.
  expectToolResult(model, 1, "readonly",
    expect.stringContaining("This Google Drive connection is read-only"));
  expectToolResult(model, 1, "readonly", expect.stringContaining(`${fileUrl(fileId)}?access=write`));
  expectToolResult(model, 2, "write", expect.stringContaining("pending:"));

  // Nothing has reached Google: the comment waits for approval.
  const post = `POST www.googleapis.com/drive/v3/files/${fileId}/comments`;
  expect(google.driveComments(fileId)).toEqual([]);
  expect(google.requests).not.toContain(post);
  const { entries } = await ws.listActions({ filter: "pending" });
  expect(entries).toHaveLength(1);
  const [entry] = entries;
  if (!entry) throw new Error("No action is pending");
  expect(entry.description).toMatchObject({
    title: "Comment on a Google Drive file",
    actionKind: { tag: "driveComments", label: "Drive comments" },
    autoApprovable: true,
    fields: expect.arrayContaining([
      { label: "File", kind: "inline", value: fileId },
      expect.objectContaining({ label: "File name" }),
    ]),
  });
  // Only the queued write opened the file's comments: the refused call observed nothing.
  const { entries: observations } = await ws.listActions({ filter: "observation" });
  expect(observations.filter(observation =>
    observation.description.title === "Open Google Drive comments")).toHaveLength(1);

  // Approved, it is posted once, as the owner's Google account.
  await ws.approveAction(entry.id);
  const [comment] = await waitFor("the comment to reach Google", async () => {
    const comments = google.driveComments(fileId);
    return comments.length > 0 ? comments : null;
  });
  expect(google.driveComments(fileId)).toHaveLength(1);
  expect(comment).toMatchObject({ content: "Looks good.", code: owner.username });
  expect(google.requests.filter(request => request === post)).toHaveLength(1);
});

it.concurrent("a collaborator who can only view a file is admitted to a workspace that read its comments, and one who cannot open it is not",
    async () => {
  using owner = await googleUser("drivecommentsreader");
  using carol = await googleUser("drivecommentscarol");
  using dave = await googleUser("drivecommentsdave");
  const fileId = `doc-${owner.username}`;
  google.driveFile(fileId, { viewOnly: [carol.username], hidden: [dave.username] });

  const file = JSON.stringify(fileId);
  // All of Drive, read-only, on an account never asked for the writes grant. An account binding on
  // purpose: a file binding's own admission check would refuse Dave for the bound file, before
  // what the listing reported is asked about.
  using state = await bound(owner, [
    { toolCall: { id: "list", name: "executeCode", arguments: { code: `export default async function(self, env) {
  const cursor = await env.DRIVE.listComments(${file});
  try {
    const pages = [];
    for (let page = await cursor.next(); page !== null; page = await cursor.next()) pages.push(page);
    return JSON.stringify(pages);
  } finally { cursor[Symbol.dispose](); }
}` } } },
    { text: "Read." },
  ], [["DRIVE", "https://drive.google.com/drive/my-drive"]]);
  const { ws, workspaceId, connectionIds, model } = state;
  const connectionId = connectionIds.get("DRIVE");
  if (connectionId === undefined) throw new Error("DRIVE is not connected");

  // The agent lists the file's comments to the end. It has none, and the empty page still reports
  // the file.
  const chatId = await ws.newChat("Read the comments.", SCRIPTED_MODEL_ID);
  await waitFor("the listing turn", async () => model.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);
  expect(model.remainingSteps()).toBe(0);
  // The whole result: no page was listed.
  expectToolResult(model, 1, "list", "Return value: []");
  const { entries: observations } = await ws.listActions({ filter: "observation" });
  expect(observations.map(entry => entry.description.title)).toContain("Read Google Drive comments");

  // Carol can open the file and not comment on it. She is admitted, checked with her own token.
  await ws.addCollaborator(carol.username, "workspace");
  const admitted = await opens(carol, workspaceId);
  expect(admitted.error).toBeUndefined();
  expect(google.driveLookups).toContain(`${carol.username} ${fileId}`);

  // Dave holds a Drive grant and cannot open the file, so he is refused, at this connection: the
  // refusal is the file's, which the listing recorded.
  await ws.addCollaborator(dave.username, "workspace");
  const refused = await opens(dave, workspaceId);
  expect(refused.error).toBeDefined();
  expect(refused.recorder.calls.at(-1)?.filter(need => need.failure)).toEqual([
    expect.objectContaining({ gatekeeperId: connectionId }),
  ]);
  expect(google.driveLookups).toContain(`${dave.username} ${fileId}`);
});

// The fake itself, asked directly: what it answers for Drive is what the gatekeeper asks of it, so
// that a request nothing here expects is reported unmocked rather than answered as a read.
it("Google's fake declines a Drive request it does not answer, and asks a write for `fields` before it looks for the comment",
    async () => {
  const [code] = nextUsernames("drivefakecaller");
  if (!code) throw new Error("No username was issued");
  const fileId = `doc-${code}`;
  google.driveFile(fileId, { hidden: [`${code}-hidden`] });
  const commentId = "doco.AAAAAAAAAAAAAAAAAAAAAA";

  expect((await askDrive(code, "GET", `${fileId}?fields=id`))?.status).toBe(200);
  expect((await askDrive(code, "GET", `${fileId}/comments?fields=comments(id)`))?.status).toBe(200);
  for (const [method, path] of [
    ["PATCH", `${fileId}?addParents=folder&fields=id`],
    ["DELETE", fileId],
    ["POST", `${fileId}?fields=id`],
    ["GET", `${fileId}?alt=media`],
    ["PATCH", `missing-${fileId}?addParents=folder`],
    ["PUT", `${fileId}/comments?fields=id`],
    ["PATCH", `${fileId}/comments/${commentId}?fields=id`],
    ["DELETE", `${fileId}/comments/${commentId}`],
    ["POST", `${fileId}/comments/${commentId}?fields=id`],
    ["DELETE", `${fileId}/comments/${commentId}/replies`],
  ] as const) {
    expect(await askDrive(code, method, path), `${method} ${path}`).toBeNull();
  }
  // Only the one files.get was a lookup of the file.
  expect(google.driveLookups.filter(lookup => lookup.endsWith(fileId))).toEqual([`${code} ${fileId}`]);

  // A reply without `fields` is refused for that, whether or not its comment exists; with `fields`,
  // for the comment. Neither is stored.
  const replies = `${fileId}/comments/${commentId}/replies`;
  expect(await driveRefusal(await askDrive(code, "POST", replies, { content: "Thanks." })))
    .toEqual({ status: 400, reason: "required", location: "fields" });
  expect(await driveRefusal(await askDrive(code, "POST", `${fileId}/comments`, { content: "Thanks." })))
    .toEqual({ status: 400, reason: "required", location: "fields" });
  expect(await driveRefusal(await askDrive(code, "POST", `${replies}?fields=id`, { content: "Thanks." })))
    .toEqual({ status: 404, reason: "notFound", location: "commentId" });
  expect(google.driveComments(fileId)).toEqual([]);
  // An account that cannot see the file is told only that, `fields` or not.
  expect(await driveRefusal(await askDrive(`${code}-hidden`, "POST", replies, { content: "Thanks." })))
    .toEqual({ status: 404, reason: "notFound", location: "fileId" });
});
