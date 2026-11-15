// A deployment admin's read-only view of a workspace (OverseerDurableObject.openForAdmin() and
// AdminWorkspaceView): what it refuses before recording anything, what it records and where, what
// it withholds, what it returns under a grant and how it looks for one, the five content reads
// and what refuses each, how live views follow the deployment's setting, and that nothing it does
// reaches the workspace's members or its connections.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding) whose impl.env is replaced
// per test: the admin path must read the environment only through it. The deployment-wide log is
// the real AdminAuditDurableObject the Overseer reaches through ctx.exports, read back through the
// TEST_ADMIN_AUDIT binding.

import { describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RpcTarget } from "capnweb";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_GRANT_ACCOUNT_CACHE_SECONDS, ADMIN_WORKSPACE_METHODS,
  DEFAULT_ADMIN_COMMIT_LOG_DEPTH, MAX_ADMIN_AUDIT_ARG_LENGTH, MAX_ADMIN_COMMIT_LOG_DEPTH,
  MAX_ADMIN_GRANTS_LISTED, getAdminAccessErrorCode,
  type AdminAccessGrant, type AdminAccessRecord, type AdminAutoApproval,
  type AdminChatAttachment, type AdminChatState, type AdminFileContent,
  type AdminObserver, type AdminPendingChange, type AdminWorkspaceAccess,
  type AdminWorkspaceMethod, type AdminWorkspaceView, type AiChatAuthorInfo,
  type BlueprintGadgetSummary, type ChatGadgetPin, type ObserverBindingNeed, type Overseer,
  type ShareLinkInfo,
} from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeChange, type CodeContent } from "@gadgets/workshop-shared/code-change";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { AdminAuditDurableObject } from "../src/admin-audit.js";
import { ADMIN_METHOD_ANSWERS, type AdminWorkspaceViewTerms } from "../src/admin-access.js";
import { newAdminGrant } from "../src/admin-grants.js";
import { MAX_BUFFERED_BLOB_SIZE } from "@gadgets/workshop-shared/gatekeeper";
import { BlobReader } from "../src/git-chunked-blob.js";
import { encodeGitTree, gitObjectOid } from "../src/git-codec.js";
import { ADMIN_CONFIG_KEY } from "../src/storage-schema/blueprints-kv.js";
import { putAction } from "./fixtures.js";
import { rpcSurface } from "./rpc-surface.js";
// Load the whole backend (the pool's `main`) up front, so its slow load does not count against the
// first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_ADMIN_AUDIT: DurableObjectNamespace<AdminAuditDurableObject>;
  }
}

// The pool's ADMINS.
const ADMIN = "deployment-admin@example.test";
const OWNER_USER_ID = "owner-user-do";
// A view that outlives its open by a margin a slow runner keeps (the open reads the config twice
// and awaits its record), then expires within the test.
const SHORT_LIFETIME_MS = 1000;
const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.test", name: "Owner" };
// The seed's collaborator, added by the owner, who holds an observer record.
const BOB: AiChatAuthorInfo = { type: "user", id: "bob@example.test", name: "Bob" };
// An id the workspace keeps no profile for: neither its owner's nor a collaborator's.
const STRANGER_ID = "stranger@example.test";
const AGENT: AiChatAuthorInfo = { type: "agent", id: "some-model", name: "Agent" };
// Who the seed's commits are by.
const COMMITTER = { name: "Owner", email: "owner@example.test" };
const REASON = "Support ticket 42";
// The pool sets no ADMIN_AUDIT_RETENTION_MIN_DAYS, so retention is at least 90 days.
const RETENTION = 90;

const GATEKEEPER_ID = 0;
// The seed's second connection, an ambient one: no person created it, and no gadget binds it.
const AMBIENT_GATEKEEPER_ID = 1;
const CHAT_ID = 1;
// A chat with no message, turn, queued call or action, which the tests that need one add.
const IDLE_CHAT_ID = 2;
// The seeded chat that holds changes to the seeded gadget which are not accepted: notes.txt
// modified, in a "changes" message, and added.txt added and todo.txt removed, in a row no message
// holds yet.
const DRAFT_CHAT_ID = 3;
// A chat with a worktree, which addWorktree() adds.
const WORKTREE_CHAT_ID = 4;
// The parent the seed's orphan commit names. The workspace stores no such object.
const MISSING_PARENT = "ab".repeat(20);

// The seeded chat's attachments: one stored as a blob, one image kept as bytes on its record, and
// one whose record names only a file of a commit.
const BLOB_ATTACHMENT_ID = "11111111-1111-4111-8111-111111111111";
const INLINE_ATTACHMENT_ID = "22222222-2222-4222-8222-222222222222";
const LEGACY_ATTACHMENT_ID = "33333333-3333-4333-8333-333333333333";
const BLOB_ATTACHMENT_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x01]);
const INLINE_ATTACHMENT_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xfe]);
const LEGACY_ATTACHMENT_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xfd, 0x02, 0x03]);

// The seed's share links, by who created each: the owner, the collaborator, and STRANGER_ID.
const OWNER_LINK_ID = "a1".repeat(32);
const BOB_LINK_ID = "b2".repeat(32);
const STRANGER_LINK_ID = "c3".repeat(32);
// The blueprint the seed publishes from its gadget.
const BLUEPRINT_ID = "published-blueprint";

// The call the seed queues for the chat's agent, and the turn seedTurn() records.
const QUEUED_CALL_ID = 7;
const MODEL_ID = "test-model";
const INITIATOR_USER_ID = "0123456789abcdef";

// What the seed stores of each thing a view withholds: each a string found nowhere else in the
// seed, so that finding one in an answer means the view returned what it withholds. BLUEPRINT_ID
// and the attachments' bytes are the others.
const WITHHELD = {
  steer: "queued steer text",
  message: "chat message text",
  callArgument: "queued call argument",
  callSummary: "queued call summary",
  observation: "observation description text",
  observationLabel: "observation field label",
  observationValue: "observation field value",
  action: "action description text",
  actionLabel: "action field label",
  actionValue: "action field value",
  hookEntry: "hook entry description text",
  hook: "bound hook description text",
  configuration: "note:connection configuration text",
  upstream: "followed-blueprint",
  headMessage: "head commit message",
  parentMessage: "parent commit message",
  file: "head file text",
} as const;

type Workspace = {
  impl: any;
  instance: OverseerDurableObject;
  state: DurableObjectState;
  id: string;
  // The deployment's stored settings, as the fake KV serves them.
  config: { adminWorkspaceAccess: AdminWorkspaceAccess; adminAuditRetentionDays: number };
  // Replaces the KV read when set, so a test can hold a call at its config read.
  kvGet?: (key: string) => Promise<string | null>;
  // The owner's account, as the workspace asks it for the owner's account-wide grant: the user
  // object asked each time, and what it answers.
  account: { asked: string[]; answer: () => unknown };
  gadgetId: number;
  // The seeded gadget's head, and the head's parent, whose files differ.
  commitId: string;
  parentCommitId: string;
  // A commit whose parent, MISSING_PARENT, is not stored.
  orphanCommitId: string;
  // The blob behind the seeded chat's blob-backed attachment.
  attachmentOid: string;
  // The message the attachments are on, and when it was written: the chat's newest row.
  attachmentSequence: number;
  lastMessageAt: Date;
};

function serveConfig(ws: Workspace, key: string): string | null {
  return key === ADMIN_CONFIG_KEY ? JSON.stringify(ws.config) : null;
}

// Sets impl.env to the pool's env plus a fake BLUEPRINTS serving `ws.config`, and `vars`.
function setEnv(ws: Workspace, vars: Record<string, unknown> = {}): void {
  ws.impl.env = {
    ...env,
    BLUEPRINTS: { get: (key: string) => ws.kvGet ? ws.kvGet(key) : serveConfig(ws, key) },
    ...vars,
  };
}

async function withWorkspace(fn: (ws: Workspace) => Promise<void>,
                             opts: { seed?: boolean } = {}): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`admin-view-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject, state) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let ws: Workspace = {
      impl, instance, state, id: state.id.toString(),
      config: { adminWorkspaceAccess: "metadata", adminAuditRetentionDays: RETENTION },
      account: { asked: [], answer: () => null },
      gadgetId: -1, commitId: "", parentCommitId: "", orphanCommitId: "", attachmentOid: "",
      attachmentSequence: -1, lastMessageAt: new Date(NaN),
    };
    setEnv(ws);
    if (opts.seed ?? true) await seed(ws);
    await fn(ws);
  });
}

async function seed(ws: Workspace): Promise<void> {
  let impl = ws.impl;
  impl.directories = {
    getByName: () => ({ syncWorkspace: async () => {}, removeWorkspace: async () => {} }),
  };
  impl.users = {
    idFromString: (id: string) => id,
    idFromName: (name: string) => name,
    get: (id: string) => ({
      id, whoami: async () => OWNER, getGadget: async () => null,
      liveAccountAdminGrant: async () => {
        ws.account.asked.push(id);
        return ws.account.answer();
      },
      // What the workspace tells its owner's account of members' activity, taken and dropped.
      messageArrived: async () => {}, setWorkspaceLastActive: async () => {},
      getWorkspace: async () => null, syncWorkspaceOutputs: async () => {},
    }),
  };
  impl.ownerId = OWNER_USER_ID;
  impl.ownerProfileId = OWNER.id;
  impl.storage.ownerId.put(OWNER_USER_ID);
  impl.storage.title.put("Quarterly plan");

  impl.storage.chatMeta.put({
    id: CHAT_ID, title: "Plans", started: new Date(0), lastActive: new Date(0),
    queuedSteers: [{ text: WITHHELD.steer, author: OWNER }],
  });
  impl.addChatMessages(CHAT_ID, OWNER, [{ type: "message", message: WITHHELD.message }]);
  await seedAttachments(ws);
  // Every field a queued call's row stores, the ones no answer may carry included.
  impl.storage.pendingAgentCalls.put({
    chatId: CHAT_ID, callId: QUEUED_CALL_ID, methodName: "summarize",
    args: [WITHHELD.callArgument], argsSummary: WITHHELD.callSummary,
    initiatorUserId: INITIATOR_USER_ID, initiatorModelId: MODEL_ID,
  });

  impl.storage.nextGatekeeperId.put(AMBIENT_GATEKEEPER_ID + 1);
  impl.storage.gatekeepers.put({
    id: GATEKEEPER_ID, resourceTitle: "Repo", resourceUrl: "https://example.com/repo",
    class: {} as any,
    creationSpec: {
      type: "gatekeeper", vendorId: "TestVendor", resourceUrl: "https://example.com/repo",
      typeUrlPattern: "https://*", configuration: WITHHELD.configuration,
    },
    createdBy: OWNER,
  });
  impl.storage.gatekeepers.put({
    id: AMBIENT_GATEKEEPER_ID, resourceTitle: "Library", class: {} as any,
    creationSpec: { type: "ambient", vendorId: "library", accountId: 3 },
  });
  putAction(impl.storage, 0, { type: "observation", gatekeeperId: GATEKEEPER_ID });
  putAction(impl.storage, 1, { type: "action", gatekeeperId: GATEKEEPER_ID });
  putAction(impl.storage, 2, { type: "bindHook", gatekeeperId: GATEKEEPER_ID });
  let observation = impl.storage.actions.get(0);
  observation.description.description = WITHHELD.observation;
  observation.description.fields = [{
    label: WITHHELD.observationLabel, kind: "inline", value: WITHHELD.observationValue,
  }];
  impl.storage.actions.put(observation);
  let action = impl.storage.actions.get(1);
  action.description.description = WITHHELD.action;
  action.description.fields =
      [{ label: WITHHELD.actionLabel, kind: "inline", value: WITHHELD.actionValue }];
  impl.storage.actions.put(action);
  let hook = impl.storage.actions.get(2);
  hook.hookId = 0;
  hook.description.description = WITHHELD.hookEntry;
  impl.storage.actions.put(hook);
  impl.storage.boundHooks.put({
    id: 0, actionId: 2, gatekeeperId: GATEKEEPER_ID, controller: {} as any, callback: {} as any,
    description: { title: "On push", description: WITHHELD.hook }, enabled: true,
  });

  // The gadget's history: its head, whose parent held another notes.txt and a file since removed.
  ws.parentCommitId = await commitFiles(ws,
      { "notes.txt": "first notes\n", "old.txt": "dropped\n", "todo.txt": "todo\n" },
      { message: WITHHELD.parentMessage, timestamp: new Date(1699990000_000) });
  ws.commitId = await commitFiles(ws,
      { "notes.txt": `${WITHHELD.file}\n`, "todo.txt": "todo\n" },
      { parents: [ws.parentCommitId], message: WITHHELD.headMessage });
  ws.orphanCommitId = await commitFiles(ws, { "checkout.txt": "checked out\n" },
      { parents: [MISSING_PARENT], message: "checked out" });
  let gadget = impl.createGadget("Notes", "NOTES", undefined, undefined, ws.commitId);
  ws.gadgetId = gadget.id;
  impl.storage.gadgets.put({
    ...gadget,
    upstream: { blueprintId: WITHHELD.upstream },
    bindings: { REPO: { target: GATEKEEPER_ID } },
  });

  // lastActive differs by chat: chatMeta.byLastActive is a unique index.
  impl.storage.chatMeta.put(
      { id: DRAFT_CHAT_ID, title: "Draft", started: new Date(0), lastActive: new Date(1000) });
  await submit(ws, DRAFT_CHAT_ID, { [ws.gadgetId]: [["notes.txt", { set: "draft notes\n" }]] },
      [{ gadgetId: ws.gadgetId, baseCommit: ws.commitId }]);
  impl.materializeChatChanges(DRAFT_CHAT_ID);
  await submit(ws, DRAFT_CHAT_ID, {
    [ws.gadgetId]: [["added.txt", { set: "added\n" }], ["todo.txt", { remove: true }]],
  });
  seedSharing(ws);
}

// Shares the workspace: a collaborator who holds an observer record, three share links, an
// auto-approval rule and a published blueprint.
function seedSharing(ws: Workspace): void {
  let storage = ws.impl.storage;
  storage.collaborators.put({
    profile: BOB,
    addedBy: [{ type: "user", sharer: OWNER.id, created: new Date(0), role: "build" }],
  });
  // Every field an observer's record stores, the ones no answer may carry included.
  storage.observers.put({
    profileId: BOB.id, observerId: "observer-bob", accountChoices: { [GATEKEEPER_ID]: 7 },
  });

  storage.shareKeys.put({
    id: OWNER_LINK_ID, note: "For the team", created: new Date(1000), createdBy: OWNER.id,
    role: "build",
  });
  storage.shareKeys.put({
    id: BOB_LINK_ID, note: "Demo", created: new Date(2000), createdBy: BOB.id, role: "use",
    gadgetId: ws.gadgetId,
  });
  // A link from before links had roles, by someone the workspace keeps no profile for.
  storage.shareKeys.put({ id: STRANGER_LINK_ID, created: new Date(3000), createdBy: STRANGER_ID });

  // A rule for a kind no seeded action is of, so it applies to none of them.
  storage.autoApproveTags.put({
    gatekeeperId: GATEKEEPER_ID, actionKind: { tag: "publish", label: "Publishes" },
    enabledBy: OWNER,
  });

  storage.blueprints.put({
    id: BLUEPRINT_ID, gadgetId: ws.gadgetId, commitId: ws.commitId,
    metadata: {
      title: "Notes kit", description: "Keeps notes", author: OWNER, created: new Date(0),
      version: 2, lastUpdated: new Date(5000), screenshot: true, bindings: {},
    },
  });
}

// The seed's observer as a view lists them: an entry's two fields and a choice's three, and
// nothing else of the stored record.
function seededObservers(): AdminObserver[] {
  return [{
    profile: BOB,
    accountChoices: [{ gatekeeperId: GATEKEEPER_ID, accountId: 7, vendorId: "testvendor" }],
  }];
}

// The seed's share links as a view lists them, each with its creator resolved.
function seededShareLinks(ws: Workspace): ShareLinkInfo[] {
  return [
    {
      linkId: OWNER_LINK_ID, note: "For the team", created: new Date(1000), createdBy: OWNER,
      role: "build",
    },
    {
      linkId: BOB_LINK_ID, note: "Demo", created: new Date(2000), createdBy: BOB, role: "use",
      gadgetId: ws.gadgetId,
    },
    {
      linkId: STRANGER_LINK_ID, note: undefined, created: new Date(3000),
      createdBy: { type: "user", id: STRANGER_ID, name: STRANGER_ID }, role: "build",
    },
  ];
}

// The seed's auto-approval rule as a view lists it.
function seededAutoApprovals(): AdminAutoApproval[] {
  return [{
    gatekeeperId: GATEKEEPER_ID, actionKind: { tag: "publish", label: "Publishes" },
    enabledBy: OWNER,
  }];
}

// The seed's blueprint as a view lists it: its id is "" and it has no `screenshotUrl`.
function seededBlueprint(): BlueprintGadgetSummary {
  return {
    id: "", title: "Notes kit", description: "Keeps notes", version: 2,
    codeVersionDate: new Date(1700000000_000), dirty: undefined,
  };
}

// What a collaborator must pass for each of the seed's connections, with the vendor as the
// connection's creationSpec spells it.
const REPO_REQUIREMENT: ObserverBindingNeed = {
  gatekeeperId: GATEKEEPER_ID, vendorId: "TestVendor", resourceTitle: "Repo",
  resourceUrl: "https://example.com/repo", resourceTypeId: undefined,
};
const LIBRARY_REQUIREMENT: ObserverBindingNeed = {
  gatekeeperId: AMBIENT_GATEKEEPER_ID, vendorId: "library", resourceTitle: "Library",
  resourceUrl: undefined, resourceTypeId: undefined,
};

// Writes `files` as a commit by COMMITTER.
async function commitFiles(ws: Workspace, files: Record<string, string>, options: {
  parents?: string[], message?: string, timestamp?: Date,
} = {}): Promise<string> {
  return await ws.impl.gitCache.writeFilesAsCommit(new Map(Object.entries(files)), {
    parents: options.parents ?? [],
    author: COMMITTER,
    message: options.message ?? "test commit",
    timestamp: options.timestamp ?? new Date(1700000000_000),
  });
}

// A member's submission of `change` at the chat's current stream position, declaring `pins`,
// each from a client of its own.
async function submit(ws: Workspace, chatId: number, change: CodeChange,
                      pins?: ChatGadgetPin[]): Promise<void> {
  let codeBase = ws.impl.storage.chatMeta.get(chatId).codeBase ?? { generation: 0, revision: 0 };
  await ws.impl.submitCodeChange(chatId, {
    generation: codeBase.generation, revision: codeBase.revision,
    clientId: crypto.randomUUID(), seq: 1, change, ...(pins ? { pins } : {}),
  }, OWNER, OWNER_USER_ID);
}

// Lets what a member's change starts in the background (telling the owner's account) finish.
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

// An `edit` of one file, built the way clients build theirs.
function editChange(id: number, path: string, before: string, after: string): CodeChange {
  let content = (text: string): CodeContent => new Map([[id, new Map([[path, text]])]]);
  return diffFiles(content(before), content(after));
}

// One agent step that changes code, as the end of a turn commits it.
async function agentStep(ws: Workspace, chatId: number, change: CodeChange): Promise<void> {
  await ws.impl.commitAgentStep(chatId, AGENT, [{ type: "message", message: "step" }], {
    changes: [{ change }], createdGadgets: [], createdWorktrees: [], addedBindings: [],
    worktreeCommits: [],
  });
}

// Adds a chat with a worktree at a commit of `files`, none of which the chat has touched.
async function addWorktree(ws: Workspace, files: Record<string, string>)
    : Promise<{ id: number, baseCommit: string }> {
  return await addWorktreeAt(ws, await commitFiles(ws, files));
}

// Adds a chat with a worktree at `baseCommit`, which the chat has not touched.
async function addWorktreeAt(ws: Workspace, baseCommit: string)
    : Promise<{ id: number, baseCommit: string }> {
  let impl = ws.impl;
  impl.storage.chatMeta.put({
    id: WORKTREE_CHAT_ID, title: "Repo work", started: new Date(0), lastActive: new Date(2000),
  });
  let { id, title } = await impl.createWorktree("Repo", WORKTREE_CHAT_ID, baseCommit);
  await impl.commitAgentStep(WORKTREE_CHAT_ID, AGENT, [{ type: "message", message: "step" }], {
    changes: [], createdGadgets: [],
    createdWorktrees: [{ worktreeId: id, title, bindingName: "TREE" }],
    addedBindings: [], worktreeCommits: [],
  });
  return { id, baseCommit };
}

// Adds a chat with a worktree at a commit of four files, changed every way a listing tells
// apart: a.txt edited by a step's message, which pins the worktree, and then, in rows no message
// holds yet, new.txt added, gone.txt removed, and same.txt edited and edited back to its base
// text. src/untouched.txt is never touched.
async function addWorktreeChat(ws: Workspace): Promise<{ id: number, baseCommit: string }> {
  let worktree = await addWorktree(ws, {
    "a.txt": "one\n", "gone.txt": "bye\n", "same.txt": "same\n", "src/untouched.txt": "kept\n",
  });
  let { id } = worktree;
  await agentStep(ws, WORKTREE_CHAT_ID, editChange(id, "a.txt", "one\n", "one!\n"));
  await submit(ws, WORKTREE_CHAT_ID,
      { [id]: [["new.txt", { set: "fresh\n" }], ["gone.txt", { remove: true }]] });
  await submit(ws, WORKTREE_CHAT_ID, editChange(id, "same.txt", "same\n", "changed\n"));
  await submit(ws, WORKTREE_CHAT_ID, editChange(id, "same.txt", "changed\n", "same\n"));
  return worktree;
}

// The seeded draft chat's pending change, as a view lists it.
function seededPendingChange(ws: Workspace): AdminPendingChange {
  return {
    gadgetId: ws.gadgetId, baseCommit: ws.commitId, mergedCommit: ws.commitId,
    added: ["added.txt"], modified: ["notes.txt"], removed: ["todo.txt"],
  };
}

// Adds a message with three attachments to the seeded chat. The stored references carry what a
// listing must drop: the blob-backed one its path in the scratch worktree, the image its bytes.
// The image has no name, and neither it nor the legacy one has an oid.
async function seedAttachments(ws: Workspace): Promise<void> {
  let impl = ws.impl;
  ws.attachmentOid = impl.gitCache.writeBlob(BLOB_ATTACHMENT_BYTES).oid;
  let legacyCommitId = await impl.gitCache.writeFilesAsCommit(
      new Map([["legacy.pdf", impl.gitCache.writeBlob(LEGACY_ATTACHMENT_BYTES)]]), {
        parents: [],
        author: { name: "Owner", email: "owner@example.test" },
        message: "attachments",
        timestamp: new Date(1700000000_000),
      });
  impl.storage.chatAttachmentContent.put({
    fileId: BLOB_ATTACHMENT_ID,
    state: {
      type: "committed", chatId: CHAT_ID, oid: ws.attachmentOid, workspacePath: "report.pdf",
    },
  });
  impl.storage.chatAttachmentContent.put({
    fileId: INLINE_ATTACHMENT_ID, data: INLINE_ATTACHMENT_BYTES,
    state: { type: "committed", chatId: CHAT_ID },
  });
  impl.storage.chatAttachmentContent.put({
    fileId: LEGACY_ATTACHMENT_ID,
    state: {
      type: "committed", chatId: CHAT_ID, workspaceCommitId: legacyCommitId,
      workspacePath: "legacy.pdf",
    },
  });
  impl.addChatMessages(CHAT_ID, OWNER, [{
    type: "message", message: "see attached",
    attachments: [
      {
        id: BLOB_ATTACHMENT_ID, oid: ws.attachmentOid, mimeType: "application/pdf",
        name: "report.pdf", size: BLOB_ATTACHMENT_BYTES.byteLength, workspacePath: "report.pdf",
      },
      {
        id: INLINE_ATTACHMENT_ID, mimeType: "image/png",
        size: INLINE_ATTACHMENT_BYTES.byteLength, content: INLINE_ATTACHMENT_BYTES,
      },
      {
        id: LEGACY_ATTACHMENT_ID, mimeType: "application/pdf", name: "legacy.pdf",
        size: LEGACY_ATTACHMENT_BYTES.byteLength,
      },
    ],
  }]);
  let newest = [...impl.storage.chats.list()].at(-1);
  ws.attachmentSequence = newest.sequence;
  ws.lastMessageAt = newest.timestamp;
}

// Records an agent turn for the seeded chat, with every field a turn's record stores. The chat
// names no agent as responding, so the turn is a paused one.
function seedTurn(ws: Workspace): void {
  ws.impl.storage.activeAgents.put({
    chatId: CHAT_ID, initiatorUserId: INITIATOR_USER_ID, modelId: MODEL_ID, initiator: OWNER,
    callbackInitiated: false,
  });
}

function addIdleChat(ws: Workspace): void {
  ws.impl.storage.chatMeta.put(
      { id: IDLE_CHAT_ID, title: "Idle", started: new Date(0), lastActive: new Date(0) });
}

// The seeded chat's state once seedTurn() has run, as a view reports it: with the queued call's
// argument summary when the call ran under a grant.
function seededChatState(ws: Workspace, content = false): AdminChatState {
  return {
    turn: {
      modelId: MODEL_ID, initiator: OWNER, callbackInitiated: false, resumeAttempts: 0,
      paused: true,
    },
    lastMessageAt: ws.lastMessageAt,
    queuedCalls: [{
      callId: QUEUED_CALL_ID, methodName: "summarize", initiatorModelId: MODEL_ID,
      ...(content ? { argsSummary: WITHHELD.callSummary } : {}),
    }],
    pendingActionIds: [0, 1, 2],
  };
}

// The seeded chat's attachments as a view lists them.
function seededAttachments(ws: Workspace): AdminChatAttachment[] {
  let sequence = ws.attachmentSequence;
  return [
    {
      id: BLOB_ATTACHMENT_ID, oid: ws.attachmentOid, mimeType: "application/pdf",
      name: "report.pdf", size: BLOB_ATTACHMENT_BYTES.byteLength, sequence,
    },
    {
      id: INLINE_ATTACHMENT_ID, oid: undefined, mimeType: "image/png", name: undefined,
      size: INLINE_ATTACHMENT_BYTES.byteLength, sequence,
    },
    {
      id: LEGACY_ATTACHMENT_ID, oid: undefined, mimeType: "application/pdf", name: "legacy.pdf",
      size: LEGACY_ATTACHMENT_BYTES.byteLength, sequence,
    },
  ];
}

function terms(overrides: Partial<AdminWorkspaceViewTerms> = {}): AdminWorkspaceViewTerms {
  return {
    via: "api", access: "metadata", expiresAt: new Date(Date.now() + 600_000), ...overrides,
  };
}

function open(ws: Workspace, overrides: Partial<AdminWorkspaceViewTerms> = {},
              admin = ADMIN, reason = REASON) {
  return ws.instance.openForAdmin(admin, reason, "session-1", terms(overrides));
}

// Puts the level in force at "content": the cap, which only impl.env raises (the pool's own env
// sets none), and the admins' choice.
function allowContent(ws: Workspace): void {
  setEnv(ws, { ADMIN_WORKSPACE_ACCESS_MAX: "content" });
  ws.config.adminWorkspaceAccess = "content";
}

// A view opened for content.
function openForContent(ws: Workspace, overrides: Partial<AdminWorkspaceViewTerms> = {}) {
  return open(ws, { access: "content", ...overrides });
}

// A live grant the owner gave on this workspace, put in its storage.
function putGrant(ws: Workspace, overrides: Partial<AdminAccessGrant> = {}): AdminAccessGrant {
  let grant = {
    ...newAdminGrant({ source: "owner", scope: "workspace", grantedBy: OWNER }), ...overrides,
  };
  ws.impl.storage.adminGrants.put(grant);
  return grant;
}

// A live account-wide grant, as the owner's account answers with it.
function accountGrant(overrides: Partial<AdminAccessGrant> = {}): AdminAccessGrant {
  return {
    ...newAdminGrant({ source: "owner", scope: "account", grantedBy: OWNER }), ...overrides,
  };
}

// The keys the workspace stores its grants under.
function grantKeys(ws: Workspace): string[] {
  return storageKeys(ws).filter(key => key.startsWith("adminGrants:"));
}

// The methods whose answer holds content under a grant, and those that answer with metadata
// alone, the open left out.
const MIXED_METHODS = ADMIN_WORKSPACE_METHODS.filter(m => ADMIN_METHOD_ANSWERS[m] === "mixed");
const METADATA_METHODS = ADMIN_WORKSPACE_METHODS.filter(
    m => ADMIN_METHOD_ANSWERS[m] === "metadata" && m !== "inspectWorkspace");
// The calls the audit names that are not content reads, in its order: the open, and the methods
// everyAnswer() calls. A metadata or mixed method added to the audit's list joins it, and so
// fails every assertion made against it until everyAnswer() calls that method.
const NON_CONTENT_METHODS = ADMIN_WORKSPACE_METHODS.filter(
    m => ADMIN_METHOD_ANSWERS[m] !== "content");
// The five content reads, in the audit's order.
const CONTENT_METHODS = [
  "getChat", "readChatAttachment", "readFile", "readFileAtCommit", "readPendingFile",
] as const satisfies readonly AdminWorkspaceMethod[];

// The seed's chat as listChats() lists it.
async function seededChat(view: AdminWorkspaceView) {
  return (await view.listChats()).find(chat => chat.id === CHAT_ID)!;
}

// The code a refusal carries, failing the test if `promise` resolves.
async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    return getAdminAccessErrorCode(err) ?? `uncoded: ${String(err)}`;
  }
  throw new Error("Expected a refusal.");
}

// The deployment-wide log's records for this workspace, oldest first.
async function deploymentRecords(ws: Workspace): Promise<AdminAccessRecord[]> {
  let page = await env.TEST_ADMIN_AUDIT.getByName("")
      .list({ workspace: ws.id, limit: 200 }, RETENTION);
  return (page.records as AdminAccessRecord[]).toReversed();
}

function storageKeys(ws: Workspace): string[] {
  return [...ws.state.storage.kv.list()].map(([key]) => key);
}

// What a member could notice of the workspace: everything it stores (keys and values, git
// objects included), who is present, the sessions open and the alarm.
async function memberVisibleState(ws: Workspace) {
  return {
    storage: [...ws.state.storage.kv.list()],
    present: ws.impl.presenceSnapshot(),
    sessions: ws.impl.liveSessionCounts(),
    alarm: await ws.state.storage.getAlarm(),
  };
}

// Calls each of the seventeen metadata and mixed view methods once on the seed, and returns their
// answers by method. The five content reads are not among them: a content read has no answer on
// a metadata view (see contentReads()).
async function everyAnswer(ws: Workspace, view: AdminWorkspaceView) {
  return {
    describe: await view.describe(),
    listChats: await view.listChats(),
    getChatState: await view.getChatState(CHAT_ID),
    listChatAttachments: await view.listChatAttachments(CHAT_ID),
    listActions: await view.listActions(),
    listFiles: await view.listFiles(ws.gadgetId),
    getCommitLog: await view.getCommitLog(ws.commitId),
    listFilesAtCommit: await view.listFilesAtCommit(ws.parentCommitId),
    listChangedPaths: await view.listChangedPaths(ws.parentCommitId, ws.commitId),
    listPendingChanges: await view.listPendingChanges(DRAFT_CHAT_ID),
    listGatekeepers: await view.listGatekeepers(),
    listObservers: await view.listObservers(),
    listObserverRequirements: await view.listObserverRequirements("workspace"),
    listShareLinks: await view.listShareLinks(),
    listAutoApprovals: await view.listAutoApprovals(),
    listBlueprints: await view.listBlueprints(),
    getDiagnostics: await view.getDiagnostics(),
  };
}

describe("opening an admin view", () => {
  it("refuses an uninitialised workspace without initialising it", () => withWorkspace(async ws => {
    expect(await codeOf(open(ws))).toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
    expect(storageKeys(ws)).toStrictEqual([]);
    expect(await deploymentRecords(ws)).toStrictEqual([]);
  }, { seed: false }));

  it("refuses, unrecorded, a caller who is not an admin and an expiry already past",
      () => withWorkspace(async ws => {
    expect(await codeOf(open(ws, {}, "owner@example.test")))
        .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    expect(await codeOf(open(ws, { expiresAt: new Date(Date.now() - 1000) })))
        .toBe(ADMIN_ACCESS_ERROR_CODES.viewExpired);

    expect(await deploymentRecords(ws)).toStrictEqual([]);
  }));

  it("records the open before returning the view", () => withWorkspace(async ws => {
    let expiresAt = new Date(Date.now() + 600_000);
    await open(ws, { via: "cli", expiresAt });
    let [record, ...rest] = await deploymentRecords(ws);
    expect(rest).toStrictEqual([]);
    expect(record).toStrictEqual({
      kind: "workspace", workspaceId: ws.id, workspaceOwner: OWNER.id, at: expect.any(Date),
      admin: ADMIN, sessionId: "session-1", via: "cli", workspaceTitle: "Quarterly plan",
      method: "inspectWorkspace", args: { expiresAt: expiresAt.toISOString() }, reason: REASON,
      requested: "metadata", access: "metadata", exposed: "metadata",
    });
  }));

  it("records an open while the setting is off as refused",
      () => withWorkspace(async ws => {
    ws.config.adminWorkspaceAccess = "off";
    expect(await codeOf(open(ws))).toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);
    let records = await deploymentRecords(ws);
    expect(records.map(r => [r.method, r.access, r.refused]))
        .toStrictEqual([["inspectWorkspace", "off", ADMIN_ACCESS_ERROR_CODES.accessOff]]);
  }));

  it("fails when the record cannot be written", () => withWorkspace(async ws => {
    let live = await open(ws);
    ws.impl.adminAudits = {
      getByName: () => ({ append: async () => { throw new Error("audit store down"); } }),
    };
    await expect(open(ws)).rejects.toThrow("audit store down");
    await expect(live.listChats()).rejects.toThrow("audit store down");
    expect((await deploymentRecords(ws)).map(r => r.method)).toStrictEqual(["inspectWorkspace"]);
  }));
});

describe("a metadata view", () => {
  it("records every one of its calls, and refuses only the content reads",
      () => withWorkspace(async ws => {
    let view = await open(ws);
    await view.describe();
    await view.listChats();
    await view.getChatState(CHAT_ID);
    await view.listChatAttachments(CHAT_ID);
    await view.listActions({ filter: "all" });
    await view.listFiles(ws.gadgetId);
    await view.getCommitLog(ws.commitId);
    await view.getCommitLog(ws.commitId, 1);
    await view.listFilesAtCommit(ws.parentCommitId);
    await view.listChangedPaths(ws.parentCommitId, ws.commitId);
    await view.listPendingChanges(DRAFT_CHAT_ID);
    await view.listGatekeepers();
    await view.listObservers();
    await view.listObserverRequirements("workspace");
    await view.listObserverRequirements({ gadgetId: ws.gadgetId });
    await view.listShareLinks();
    await view.listAutoApprovals();
    await view.listBlueprints();
    await view.getDiagnostics();
    // The view was not opened for content, so each content read is refused, having read nothing.
    let refused = ADMIN_ACCESS_ERROR_CODES.contentNotRequested;
    expect(await codeOf(view.getChat(CHAT_ID, 5))).toBe(refused);
    expect(await codeOf(view.readChatAttachment(CHAT_ID, BLOB_ATTACHMENT_ID))).toBe(refused);
    expect(await codeOf(view.readFile(ws.gadgetId, "notes.txt"))).toBe(refused);
    expect(await codeOf(view.readFileAtCommit(ws.parentCommitId, "old.txt"))).toBe(refused);
    expect(await codeOf(view.readPendingFile(DRAFT_CHAT_ID, ws.gadgetId, "added.txt")))
        .toBe(refused);

    let records = await deploymentRecords(ws);
    expect(records.map(r => [r.method, r.args, r.access, r.refused])).toStrictEqual([
      ["inspectWorkspace", { expiresAt: expect.any(String) }, "metadata", undefined],
      ["describe", {}, "metadata", undefined],
      ["listChats", {}, "metadata", undefined],
      ["getChatState", { chatId: CHAT_ID }, "metadata", undefined],
      ["listChatAttachments", { chatId: CHAT_ID }, "metadata", undefined],
      ["listActions", { filter: "all" }, "metadata", undefined],
      ["listFiles", { gadgetId: ws.gadgetId }, "metadata", undefined],
      ["getCommitLog", { fromCommit: ws.commitId }, "metadata", undefined],
      ["getCommitLog", { fromCommit: ws.commitId, depth: 1 }, "metadata", undefined],
      ["listFilesAtCommit", { commitId: ws.parentCommitId }, "metadata", undefined],
      ["listChangedPaths", { fromCommit: ws.parentCommitId, toCommit: ws.commitId }, "metadata",
       undefined],
      ["listPendingChanges", { chatId: DRAFT_CHAT_ID }, "metadata", undefined],
      ["listGatekeepers", {}, "metadata", undefined],
      ["listObservers", {}, "metadata", undefined],
      ["listObserverRequirements", { grant: "workspace" }, "metadata", undefined],
      ["listObserverRequirements", { gadgetId: ws.gadgetId }, "metadata", undefined],
      ["listShareLinks", {}, "metadata", undefined],
      ["listAutoApprovals", {}, "metadata", undefined],
      ["listBlueprints", {}, "metadata", undefined],
      ["getDiagnostics", {}, "metadata", undefined],
      ["getChat", { chatId: CHAT_ID, beforeSequence: 5 }, "metadata", refused],
      ["readChatAttachment", { chatId: CHAT_ID, id: BLOB_ATTACHMENT_ID }, "metadata", refused],
      ["readFile", { gadgetId: ws.gadgetId, path: "notes.txt" }, "metadata", refused],
      ["readFileAtCommit", { commitId: ws.parentCommitId, path: "old.txt" }, "metadata", refused],
      ["readPendingFile", { chatId: DRAFT_CHAT_ID, gadgetId: ws.gadgetId, path: "added.txt" },
       "metadata", refused],
    ]);
    // The list above is kept by hand: a method the audit names fails here until it is called
    // above, and its record asserted.
    expect(new Set(records.map(r => r.method))).toStrictEqual(new Set(ADMIN_WORKSPACE_METHODS));
    expect(new Set(records.map(r => r.reason))).toStrictEqual(new Set([REASON]));
    for (let record of records) {
      expect(record).toMatchObject({ requested: "metadata", exposed: "metadata" });
      expect(record).not.toHaveProperty("grantId");
    }
    // A metadata view never asks the owner's account for a grant.
    expect(ws.account.asked).toStrictEqual([]);
  }));

  it("stores each of its records with exposed 'metadata' in the audit table",
      () => withWorkspace(async ws => {
    await everyAnswer(ws, await open(ws));
    let rows = await runInDurableObject(env.TEST_ADMIN_AUDIT.getByName(""), (_log, state) =>
        state.storage.sql.exec<{ kind: string; method: string; exposed: string | null }>(
            `SELECT kind, json_extract(record, '$.method') AS method, exposed FROM admin_audit
             WHERE workspace_id = ? ORDER BY seq`, ws.id).toArray());
    // The open and one call of each of the seventeen methods, in the audit's order.
    expect(rows).toHaveLength(18);
    expect(rows).toStrictEqual(NON_CONTENT_METHODS.map(
        method => ({ kind: "workspace", method, exposed: "metadata" })));
  }));

  it("exposes no method but the ones the audit names, the five content reads among them",
      () => withWorkspace(async ws => {
    let view = await open(ws);
    expect(view).toBeInstanceOf(RpcTarget);
    expect(rpcSurface(view)).toStrictEqual(
        new Set(ADMIN_WORKSPACE_METHODS.filter(method => method !== "inspectWorkspace")));
    // The open and twenty-two view methods.
    expect(ADMIN_WORKSPACE_METHODS).toHaveLength(23);
    for (let name of [
      "getChat", "readChatAttachment", "readFile", "readFileAtCommit", "readPendingFile",
    ]) {
      expect(name in view, name).toBe(true);
      expect(ADMIN_WORKSPACE_METHODS, name).toContain(name);
      expect((ADMIN_METHOD_ANSWERS as Record<string, string>)[name], name).toBe("content");
    }
    // Every call the audit names is classified, whatever a cast might hide from the compiler,
    // and the five are all that answer with content alone.
    for (let method of ADMIN_WORKSPACE_METHODS) {
      expect(["metadata", "mixed", "content"], method)
          .toContain((ADMIN_METHOD_ANSWERS as Record<string, string>)[method]);
    }
    expect(Object.keys(ADMIN_METHOD_ANSWERS).toSorted())
        .toStrictEqual([...ADMIN_WORKSPACE_METHODS].toSorted());
    expect(Object.values(ADMIN_METHOD_ANSWERS).filter(kind => kind === "content"))
        .toHaveLength(5);
  }));

  it("withholds content but keeps structure", () => withWorkspace(async ws => {
    seedTurn(ws);
    let impl = ws.impl;

    // Each thing withheld is in what the workspace's members are served from: a sentinel the
    // seed did not plant where a method reads would be absent from any answer, withheld or not.
    let storedCalls = [...impl.storage.pendingAgentCalls.list()];
    let blueprints = impl.blueprintSummaries();
    let reachable: [string, unknown][] = [
      [WITHHELD.steer, impl.chatMetaForClient(impl.storage.chatMeta.get(CHAT_ID)).queuedSteers],
      [WITHHELD.message, [...impl.storage.chats.list()]],
      [WITHHELD.callArgument, storedCalls.map(call => call.args)],
      [WITHHELD.callSummary, storedCalls.map(call => call.argsSummary)],
      [WITHHELD.observation, impl.storage.actions.get(0).description.description],
      [WITHHELD.observationLabel, impl.storage.actions.get(0).description.fields],
      [WITHHELD.observationValue, impl.storage.actions.get(0).description.fields],
      [WITHHELD.action, impl.storage.actions.get(1).description.description],
      [WITHHELD.actionLabel, impl.storage.actions.get(1).description.fields],
      [WITHHELD.actionValue, impl.storage.actions.get(1).description.fields],
      [WITHHELD.hookEntry, impl.storage.actions.get(2).description.description],
      [WITHHELD.hook, [...impl.storage.boundHooks.list()].map(hook => hook.description)],
      [WITHHELD.configuration, impl.storage.gatekeepers.get(GATEKEEPER_ID).creationSpec],
      [WITHHELD.upstream, impl.storage.gadgets.get(ws.gadgetId).upstream],
      [BLUEPRINT_ID, blueprints.map((blueprint: BlueprintGadgetSummary) => blueprint.id)],
      ["/blueprint-screenshot/",
       blueprints.map((blueprint: BlueprintGadgetSummary) => blueprint.screenshotUrl)],
      [WITHHELD.headMessage, impl.gitCache.readCommitLog(ws.commitId, { depth: 2 })],
      [WITHHELD.parentMessage, impl.gitCache.readCommitLog(ws.commitId, { depth: 2 })],
      [WITHHELD.file, await impl.readFileAtCommit(ws.commitId, "notes.txt")],
    ];
    for (let [sentinel, source] of reachable) {
      expect(JSON.stringify(source), sentinel).toContain(sentinel);
    }
    let attachments: [string, Uint8Array][] = [
      [BLOB_ATTACHMENT_ID, BLOB_ATTACHMENT_BYTES], [INLINE_ATTACHMENT_ID, INLINE_ATTACHMENT_BYTES],
      [LEGACY_ATTACHMENT_ID, LEGACY_ATTACHMENT_BYTES],
    ];
    for (let [id, bytes] of attachments) {
      expect(new Uint8Array(await impl.getChatAttachmentData(CHAT_ID, id)), id)
          .toStrictEqual(bytes);
    }

    // No answer of any method holds one of them. Bytes are looked for as JSON carries a byte
    // array, as a list of numbers and as base64.
    let view = await open(ws);
    let answers = await everyAnswer(ws, view);
    expect(Object.keys(answers)).toStrictEqual(
        NON_CONTENT_METHODS.filter(method => method !== "inspectWorkspace"));
    let answered = JSON.stringify(answers);
    for (let sentinel of [...Object.values(WITHHELD), BLUEPRINT_ID, "/blueprint-screenshot/"]) {
      expect(answered, sentinel).not.toContain(sentinel);
    }
    for (let [id, bytes] of attachments) {
      expect(answered, id).not.toContain(JSON.stringify(bytes).slice(1, -1));
      expect(answered, id).not.toContain(Array.from(bytes).join(","));
      expect(answered, id).not.toContain(btoa(String.fromCharCode(...bytes)));
    }

    // What stays: the structure around each thing withheld.
    let chats = answers.listChats;
    expect(chats.map(chat => chat.title)).toStrictEqual(["Draft", "Plans"]);
    expect(chats.find(chat => chat.id === CHAT_ID)).not.toHaveProperty("queuedSteers");

    // Whole answers: a stored record's other fields (a queued call's arguments, an attachment's
    // path and bytes) would pass a looser check.
    expect(answers.getChatState).toStrictEqual(seededChatState(ws));
    expect(answers.listChatAttachments).toStrictEqual(seededAttachments(ws));

    let { entries } = answers.listActions;
    expect(entries.map(entry => [entry.type, entry.description.title])).toStrictEqual([
      ["bindHook", "Action 2"], ["action", "Action 1"], ["observation", "Action 0"],
    ]);
    for (let entry of entries) {
      expect(entry.description.description).toBe("");
      expect(entry.description).not.toHaveProperty("fields");
    }

    let description = answers.describe;
    expect(description).toMatchObject({
      id: ws.id, title: "Quarterly plan", owner: OWNER,
      collaborators: [{
        profile: BOB, access: { role: "build" },
        addedBy: [{ type: "user", sharer: OWNER.id, created: new Date(0), role: "build" }],
      }],
    });
    expect(Object.keys(description).toSorted()).toStrictEqual([
      "access", "collaborators", "containsRestrictedData", "defaultGadgetId", "expiresAt",
      "grants", "id", "owner", "ownerInvitesOnly", "title", "totalCost", "workpieces",
    ]);
    expect(description.access).toBe("metadata");
    expect(description.grants).toStrictEqual([]);
    let gadget = description.workpieces.find(w => w.id === ws.gadgetId)!;
    expect(gadget).toMatchObject({ type: "gadget", title: "Notes", commitId: ws.commitId });
    expect(gadget).not.toHaveProperty("upstream");

    let [gatekeeper, ambient, ...others] = answers.listGatekeepers;
    expect(gatekeeper).toMatchObject({
      id: GATEKEEPER_ID, resourceTitle: "Repo", vendorId: "testvendor", createdBy: OWNER,
      bindings: [{ gadgetId: ws.gadgetId, name: "REPO" }],
    });
    expect(gatekeeper.hooks.map(hook => [hook.description.title, hook.description.description]))
        .toStrictEqual([["On push", ""]]);
    // The ambient connection, whole: no person created it.
    expect(ambient).toStrictEqual({
      id: AMBIENT_GATEKEEPER_ID, resourceTitle: "Library", resourceUrl: undefined,
      vendorId: "library", creationSpec: { type: "ambient", vendorId: "library", accountId: 3 },
      createdBy: undefined, bindings: [], hooks: [],
    });
    expect(others).toStrictEqual([]);

    // Whole answers again: an observer's stored record also holds the id connections know them
    // by.
    expect(answers.listObservers).toStrictEqual(seededObservers());
    expect(answers.listShareLinks).toStrictEqual(seededShareLinks(ws));
    expect(answers.listAutoApprovals).toStrictEqual(seededAutoApprovals());
    // A blueprint keeps its title, description, version and date, without the id that is a link
    // to its code, or the screenshot URL that holds it.
    expect(answers.listBlueprints).toStrictEqual([seededBlueprint()]);

    expect(answers.listFiles).toStrictEqual(
        [{ name: "notes.txt", kind: "file" }, { name: "todo.txt", kind: "file" }]);

    // A commit keeps its id, parents, author and time, without its message.
    expect(answers.getCommitLog).toStrictEqual([
      {
        oid: ws.commitId, parents: [ws.parentCommitId], message: "", author: COMMITTER,
        timestamp: new Date(1700000000_000),
      },
      {
        oid: ws.parentCommitId, parents: [], message: "", author: COMMITTER,
        timestamp: new Date(1699990000_000),
      },
    ]);
    // Paths are names, so these answer in full.
    expect(answers.listFilesAtCommit).toStrictEqual([
      { name: "notes.txt", kind: "file" }, { name: "old.txt", kind: "file" },
      { name: "todo.txt", kind: "file" },
    ]);
    expect(answers.listChangedPaths).toStrictEqual(["notes.txt", "old.txt"]);
    expect(answers.listPendingChanges).toStrictEqual([seededPendingChange(ws)]);
  }));

  it("reads a chat's turn, queued calls and attachments", () => withWorkspace(async ws => {
    let view = await open(ws);

    // No turn is recorded yet.
    let idle = await view.getChatState(CHAT_ID);
    expect(idle.turn).toBeUndefined();
    expect((await view.getDiagnostics()).activeAgentChatIds).toStrictEqual([]);

    // Whole answers. An action of the chat that was decided is not pending, so the answer leaves
    // it out.
    seedTurn(ws);
    putAction(ws.impl.storage, 3, { state: "approved", gatekeeperId: GATEKEEPER_ID });
    expect(await view.getChatState(CHAT_ID)).toStrictEqual(seededChatState(ws));
    expect(await view.listChatAttachments(CHAT_ID)).toStrictEqual(seededAttachments(ws));
    expect((await view.getDiagnostics()).activeAgentChatIds).toStrictEqual([CHAT_ID]);

    // The turn runs once the chat names its agent, and its attempts are the record's.
    let impl = ws.impl;
    impl.storage.chatMeta.put({
      ...impl.storage.chatMeta.get(CHAT_ID),
      activeAgent: { type: "agent", id: MODEL_ID, name: "Test model" },
    });
    impl.storage.activeAgents.put({ ...impl.storage.activeAgents.get(CHAT_ID), resumeAttempts: 2 });
    expect((await view.getChatState(CHAT_ID)).turn).toStrictEqual({
      modelId: MODEL_ID, initiator: OWNER, callbackInitiated: false, resumeAttempts: 2,
      paused: false,
    });
    expect((await view.getDiagnostics()).activeAgentChatIds).toStrictEqual([CHAT_ID]);
  }));

  it("returns nothing when the deployment-wide record cannot be written",
      () => withWorkspace(async ws => {
    let view = await open(ws);
    ws.impl.adminAudits = {
      getByName: () => ({ append: async () => { throw new Error("audit store down"); } }),
    };
    await expect(view.listChats()).rejects.toThrow("audit store down");
    expect((await deploymentRecords(ws)).map(r => r.method)).toStrictEqual(["inspectWorkspace"]);
  }));
});

describe("an inspection", () => {
  it("changes nothing a member sees and joins no session", () => withWorkspace(async ws => {
    let impl = ws.impl;
    let actionsBefore = [...impl.storage.actions.list()];
    let notified: string[] = [];
    impl.storage.actions.subscribe({
      add: () => notified.push("add"),
      update: () => notified.push("update"),
      remove: () => notified.push("remove"),
    });
    // A chat with a worktree, whose content the view is the one to fold: the fold that reads its
    // bases from stored objects alone.
    let worktree = await addWorktreeChat(ws);
    await settled();
    // The level and the owner's grant that the content reads below need.
    allowContent(ws);
    putGrant(ws);
    impl.invalidateChatContent(WORKTREE_CHAT_ID);
    impl.invalidateChatContent(DRAFT_CHAT_ID);
    let before = await memberVisibleState(ws);

    // The seventeen metadata and mixed methods, through a view opened for metadata.
    let view = await open(ws);
    let answers = await everyAnswer(ws, view);
    expect(await view.listPendingChanges(WORKTREE_CHAT_ID)).toHaveLength(1);
    await view.listObserverRequirements({ gadgetId: ws.gadgetId });
    // Asks the owner's account, since the owner created a link, and still writes nothing.
    expect(answers.listShareLinks).toHaveLength(3);

    // The five content reads, under the grant, through a view opened for content: each attachment
    // from wherever the workspace stores it, read to its end, and a file of the worktree chat,
    // whose content this read folds.
    let content = await openForContent(ws);
    impl.invalidateChatContent(WORKTREE_CHAT_ID);
    impl.invalidateChatContent(DRAFT_CHAT_ID);
    for (let read of Object.values(contentReads(ws, content))) await read();
    for (let id of [BLOB_ATTACHMENT_ID, INLINE_ATTACHMENT_ID, LEGACY_ATTACHMENT_ID]) {
      expect((await bytesOf(await content.readChatAttachment(CHAT_ID, id))).byteLength)
          .toBeGreaterThan(0);
    }
    expect(await content.readPendingFile(WORKTREE_CHAT_ID, worktree.id, "a.txt"))
        .toStrictEqual({ kind: "text", text: "one!\n" });
    // Every one of them answered: none was refused.
    let reads = (await deploymentRecords(ws)).filter(r => r.requested === "content").slice(1);
    expect(reads.map(r => [r.method, r.refused])).toStrictEqual([
      ...CONTENT_METHODS, "readChatAttachment", "readChatAttachment", "readChatAttachment",
      "readPendingFile",
    ].map(method => [method, undefined]));

    expect(await memberVisibleState(ws)).toStrictEqual(before);
    expect(notified).toStrictEqual([]);
    expect([...impl.storage.actions.list()]).toStrictEqual(actionsBefore);
    expect(impl.liveSessionCounts()).toStrictEqual({ build: 0, use: 0 });
    expect((await view.getDiagnostics()).sessions).toStrictEqual({ build: 0, use: 0 });
  }));
});

describe("a live view's checks", () => {
  it("refuses, recorded, a call once the setting is off", () => withWorkspace(async ws => {
    let view = await open(ws);
    ws.config.adminWorkspaceAccess = "off";
    expect(await codeOf(view.describe())).toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);
    let records = await deploymentRecords(ws);
    expect(records.at(-1)).toMatchObject(
        { method: "describe", access: "off", refused: ADMIN_ACCESS_ERROR_CODES.accessOff });
  }));

  it("answers again once the setting is back at metadata", () => withWorkspace(async ws => {
    let view = await open(ws);
    ws.config.adminWorkspaceAccess = "off";
    expect(await codeOf(view.listChats())).toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);
    ws.config.adminWorkspaceAccess = "metadata";
    expect((await view.listChats()).map(chat => chat.title)).toStrictEqual(["Draft", "Plans"]);
    expect((await deploymentRecords(ws)).map(r => [r.method, r.access, r.refused])).toStrictEqual([
      ["inspectWorkspace", "metadata", undefined],
      ["listChats", "off", ADMIN_ACCESS_ERROR_CODES.accessOff],
      ["listChats", "metadata", undefined],
    ]);
  }));

  // The pool's own `env` holds no cap, so each refusal here also shows that the view reads the
  // cap through impl.env alone. "full" is not a level, so as a cap it fails closed as any value
  // that is not one does.
  it.each(["off", "full", "FULL"])(
      "refuses, recorded, the open and a live view's next call while the environment's cap is %s",
      cap => withWorkspace(async ws => {
    expect((env as { ADMIN_WORKSPACE_ACCESS_MAX?: unknown }).ADMIN_WORKSPACE_ACCESS_MAX)
        .toBeUndefined();
    let view = await open(ws);

    setEnv(ws, { ADMIN_WORKSPACE_ACCESS_MAX: cap });
    expect(await codeOf(view.describe())).toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);
    expect(await codeOf(open(ws))).toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);
    expect(ws.config.adminWorkspaceAccess).toBe("metadata");

    setEnv(ws);
    expect((await view.describe()).title).toBe("Quarterly plan");
    expect((await deploymentRecords(ws)).map(r => [r.method, r.access, r.refused])).toStrictEqual([
      ["inspectWorkspace", "metadata", undefined],
      ["describe", "off", ADMIN_ACCESS_ERROR_CODES.accessOff],
      ["inspectWorkspace", "off", ADMIN_ACCESS_ERROR_CODES.accessOff],
      ["describe", "metadata", undefined],
    ]);
  }));

  it("turns off for a stored level that is not one", () => withWorkspace(async ws => {
    let view = await open(ws);
    // What the deployment's settings store, as the fake KV then serves it.
    ws.config.adminWorkspaceAccess = "full" as never;
    expect(await codeOf(view.describe())).toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);
    expect(await codeOf(open(ws))).toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);
    expect((await deploymentRecords(ws)).map(r => [r.method, r.access, r.refused])).toStrictEqual([
      ["inspectWorkspace", "metadata", undefined],
      ["describe", "off", ADMIN_ACCESS_ERROR_CODES.accessOff],
      ["inspectWorkspace", "off", ADMIN_ACCESS_ERROR_CODES.accessOff],
    ]);
  }));

  it("refuses, unrecorded, a call after expiry or demotion, or on a deleted workspace",
      () => withWorkspace(async ws => {
    allowContent(ws);
    let expiresAt = new Date(Date.now() + SHORT_LIFETIME_MS);
    let shortLived = await open(ws, { expiresAt });
    let shortLivedForContent = await openForContent(ws, { expiresAt });
    let view = await open(ws);
    let forContent = await openForContent(ws);
    let reads = watchReads(ws);
    await scheduler.wait(SHORT_LIFETIME_MS + 100);

    // `code` is what a mixed method and each content read is refused with, through `views`: a
    // view opened for metadata, and one opened for content.
    let expectRefused = async (views: AdminWorkspaceView[], code: string) => {
      for (let each of views) expect(await codeOf(each.listChats())).toBe(code);
      for (let method of CONTENT_METHODS) {
        expect(await codeOf(contentReads(ws, views[1])[method]()), method).toBe(code);
      }
    };
    // The content reads have a refusal of their own to record, and a grant to look for: neither
    // comes before these checks, with a live grant in the workspace or with none.
    let ownerId = ws.impl.ownerId;
    for (let grant of [putGrant(ws), undefined]) {
      if (!grant) {
        for (let stored of ws.impl.storage.adminGrants.list()) {
          ws.impl.storage.adminGrants.delete(stored.id);
        }
      }
      await expectRefused(
          [shortLived, shortLivedForContent], ADMIN_ACCESS_ERROR_CODES.viewExpired);

      setEnv(ws, { ADMIN_WORKSPACE_ACCESS_MAX: "content", ADMINS: ["someone-else@example.test"] });
      await expectRefused([view, forContent], ADMIN_ACCESS_ERROR_CODES.notAdmin);
      allowContent(ws);

      ws.impl.ownerId = undefined;
      await expectRefused([view, forContent], ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
      ws.impl.ownerId = ownerId;
    }

    // Nothing recorded but the four opens, nothing read, and the owner's account never asked.
    expect((await deploymentRecords(ws)).map(r => r.method))
        .toStrictEqual([1, 2, 3, 4].map(() => "inspectWorkspace"));
    for (let read of reads) expect(read).not.toHaveBeenCalled();
    expect(ws.account.asked).toStrictEqual([]);
  }));

  it("writes nothing for a call that the workspace's deletion overtakes",
      () => withWorkspace(async ws => {
    let view = await open(ws);
    let reached!: () => void;
    let atRead = new Promise<void>(resolve => { reached = resolve; });
    let release!: () => void;
    let released = new Promise<void>(resolve => { release = resolve; });
    ws.kvGet = async key => {
      reached();
      await released;
      return serveConfig(ws, key);
    };

    let call = view.listChats();
    await atRead;
    await ws.state.storage.deleteAll();
    ws.impl.ownerId = undefined;
    release();

    expect(await codeOf(call)).toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
    expect(storageKeys(ws)).toStrictEqual([]);
    expect((await deploymentRecords(ws)).map(r => r.method)).toStrictEqual(["inspectWorkspace"]);
  }));

  it("writes nothing for a call that expires while it reads the setting",
      () => withWorkspace(async ws => {
    let view = await open(ws, { expiresAt: new Date(Date.now() + SHORT_LIFETIME_MS) });
    let reached!: () => void;
    let atRead = new Promise<void>(resolve => { reached = resolve; });
    let release!: () => void;
    let released = new Promise<void>(resolve => { release = resolve; });
    ws.kvGet = async key => {
      reached();
      await released;
      return serveConfig(ws, key);
    };

    let call = view.listChats();
    await atRead;
    await scheduler.wait(SHORT_LIFETIME_MS + 100);
    release();

    expect(await codeOf(call)).toBe(ADMIN_ACCESS_ERROR_CODES.viewExpired);
    expect((await deploymentRecords(ws)).map(r => r.method)).toStrictEqual(["inspectWorkspace"]);
  }));
});

// Holds describe() at its read of the owner's profile until `release`.
function holdDescribe(ws: Workspace): { reached: Promise<void>, release: () => void } {
  let reach!: () => void;
  let reached = new Promise<void>(resolve => { reach = resolve; });
  let release!: () => void;
  let released = new Promise<void>(resolve => { release = resolve; });
  ws.impl.users = {
    idFromString: (id: string) => id,
    get: () => ({ whoami: async () => { reach(); await released; return OWNER; } }),
  };
  return { reached, release };
}

describe("a call overtaken while it reads its answer", () => {
  it("writes nothing when the workspace is deleted", () => withWorkspace(async ws => {
    let view = await open(ws);
    let hold = holdDescribe(ws);

    let call = view.describe();
    await hold.reached;
    await ws.state.storage.deleteAll();
    ws.impl.ownerId = undefined;
    hold.release();

    expect(await codeOf(call)).toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
    expect(storageKeys(ws)).toStrictEqual([]);
    expect((await deploymentRecords(ws)).map(r => r.method)).toStrictEqual(["inspectWorkspace"]);
  }));

  it("writes nothing when the view expires", () => withWorkspace(async ws => {
    let view = await open(ws, { expiresAt: new Date(Date.now() + SHORT_LIFETIME_MS) });
    let hold = holdDescribe(ws);

    let call = view.describe();
    await hold.reached;
    await scheduler.wait(SHORT_LIFETIME_MS + 100);
    hold.release();

    expect(await codeOf(call)).toBe(ADMIN_ACCESS_ERROR_CODES.viewExpired);
    expect((await deploymentRecords(ws)).map(r => r.method)).toStrictEqual(["inspectWorkspace"]);
  }));
});

describe("the records' bounds", () => {
  it("cut a long title, while describe() returns it whole",
      () => withWorkspace(async ws => {
    let title = "t".repeat(2_000_000);
    ws.impl.storage.title.put(title);
    let view = await open(ws);
    expect((await view.describe()).title).toBe(title);

    let cut = `${"t".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH - 1)}…`;
    let records = await deploymentRecords(ws);
    expect(records.map(r => r.workspaceTitle)).toStrictEqual([cut, cut]);
  }));

  it("report the workspace's operational state in the diagnostics", () => withWorkspace(async ws => {
    let view = await open(ws);
    let diagnostics = await view.getDiagnostics();
    expect(diagnostics).toMatchObject({
      chats: 2, pendingActions: 3, hooks: { total: 1, enabled: 1 }, observers: 1,
      ownerRegistrationPending: false, activeAgentChatIds: [], pendingAgentCalls: 1,
    });
    expect(diagnostics.storageBytes).toBeGreaterThan(0);
    // No member has the workspace open, and the admin's own view is not presence.
    expect(diagnostics.present).toStrictEqual([]);

    let leave = ws.impl.joinPresence(BOB.id, BOB, "build");
    expect((await view.getDiagnostics()).present)
        .toStrictEqual([{ key: expect.any(String), user: BOB, role: "build" }]);
    leave();
    expect((await view.getDiagnostics()).present).toStrictEqual([]);
  }));
});

// What the diagnostics report as `sessions`: OverseerImpl.liveSessionCounts(). The holds are taken
// here as a member's session takes them, with joinSession(); which sessions take one is pinned
// in connection-creator.test.ts, through a real open.
describe("live sessions in the diagnostics", () => {
  it("count each hold a collaborator has on the workspace, by role",
      () => withWorkspace(async ws => {
    let impl = ws.impl;
    let view = await open(ws);
    let sessions = async () => (await view.getDiagnostics()).sessions;
    expect(await sessions()).toStrictEqual({ build: 0, use: 0 });

    let leaveFirst = impl.joinSession({ kind: "build", profileId: BOB.id });
    expect(await sessions()).toStrictEqual({ build: 1, use: 0 });
    // A second hold of the same collaborator's: the number counts holds, not people.
    let leaveSecond = impl.joinSession({ kind: "build", profileId: BOB.id });
    expect(await sessions()).toStrictEqual({ build: 2, use: 0 });
    expect(impl.liveCollaborators()).toStrictEqual([BOB.id]);
    let leaveUse = impl.joinSession({ kind: "use", profileId: STRANGER_ID }, ws.gadgetId);
    expect(await sessions()).toStrictEqual({ build: 2, use: 1 });

    // Each leave takes back its own hold, and only once.
    leaveFirst();
    leaveFirst();
    expect(await sessions()).toStrictEqual({ build: 1, use: 1 });
    leaveUse();
    expect(await sessions()).toStrictEqual({ build: 1, use: 0 });
    leaveSecond();
    expect(await sessions()).toStrictEqual({ build: 0, use: 0 });
  }));
});

// Deletes a stored object that a connection could serve again, and makes reaching any connection's
// facet visible to the test.
function forbidPulls(ws: Workspace, oid: string, type: "blob" | "tree" | "commit")
    : { pulled: boolean } {
  let state = { pulled: false };
  ws.impl.storage.gitObjectMetadata.put(
      { oid, type, onRemote: [GATEKEEPER_ID], pullableFrom: [], pendingPush: [] });
  ws.impl.storage.gitObjects.delete(oid);
  ws.impl.getGatekeeperFacet = () => {
    state.pulled = true;
    throw new Error("an admin read reached a connection");
  };
  return state;
}

describe("file listings", () => {
  it("never pull a missing tree through a connection", () => withWorkspace(async ws => {
    let view = await open(ws);
    let root = await ws.impl.gitCache.pathEntryAtCommit(ws.commitId, "");
    let pulls = forbidPulls(ws, root.oid, "tree");

    await expect(view.listFiles(ws.gadgetId))
        .rejects.toThrow(`The tree ${root.oid} is not in the workspace's git store.`);
    expect(pulls.pulled).toBe(false);
  }));

  it("read only a permanent gadget's head", () => withWorkspace(async ws => {
    let view = await open(ws);
    await expect(view.listFiles(GATEKEEPER_ID))
        .rejects.toThrow(`No gadget with committed code has id ${GATEKEEPER_ID}.`);
    await expect(view.listFiles(999)).rejects.toThrow("No gadget with committed code has id 999.");
  }));
});

describe("chat reads", () => {
  it("report a chat with nothing recorded or waiting as such", () => withWorkspace(async ws => {
    addIdleChat(ws);
    let view = await open(ws);
    let state = await view.getChatState(IDLE_CHAT_ID);
    expect(state.turn).toBeUndefined();
    expect(state.lastMessageAt).toBeUndefined();
    expect(state.queuedCalls).toStrictEqual([]);
    expect(state.pendingActionIds).toStrictEqual([]);
    expect(await view.listChatAttachments(IDLE_CHAT_ID)).toStrictEqual([]);
    // As for an id that names no chat, which only the listing answers.
    expect(await view.listChatAttachments(999)).toStrictEqual([]);
  }));

  it("record a read that fails as an attempt", () => withWorkspace(async ws => {
    let view = await open(ws);

    await expect(view.getChatState(999)).rejects.toThrow("No such chatId: 999");

    let records = (await deploymentRecords(ws)).slice(1);
    expect(records.map(r => [r.method, r.args, r.access])).toStrictEqual([
      ["getChatState", { chatId: 999 }, "metadata"],
    ]);
    for (let record of records) expect(record).not.toHaveProperty("refused");
  }));
});

// What a read throws for an id that names no stored commit, and for an object that is missing.
const noStoredCommit = (oid: string) => `No commit ${oid} is stored in this workspace.`;
const missingObject = (oid: string) => `${oid} is not in the workspace's git store.`;

describe("history and stored commits", () => {
  it("read a commit's history, its files and what changed since its parent",
      () => withWorkspace(async ws => {
    let view = await open(ws);
    let head = {
      oid: ws.commitId, parents: [ws.parentCommitId], message: "", author: COMMITTER,
      timestamp: new Date(1700000000_000),
    };
    let parent = {
      oid: ws.parentCommitId, parents: [], message: "", author: COMMITTER,
      timestamp: new Date(1699990000_000),
    };
    expect(await view.getCommitLog(ws.commitId)).toStrictEqual([head, parent]);
    expect(await view.getCommitLog(ws.commitId, 1)).toStrictEqual([head]);
    // A commit whose parent is not stored lists alone: the walk stops there.
    expect((await view.getCommitLog(ws.orphanCommitId)).map(commit => [commit.oid, commit.parents]))
        .toStrictEqual([[ws.orphanCommitId, [MISSING_PARENT]]]);

    // The parent is no gadget's head, and reads as one does.
    expect(await view.listFilesAtCommit(ws.parentCommitId)).toStrictEqual([
      { name: "notes.txt", kind: "file" }, { name: "old.txt", kind: "file" },
      { name: "todo.txt", kind: "file" },
    ]);

    expect(await view.listChangedPaths(ws.parentCommitId, ws.commitId))
        .toStrictEqual(["notes.txt", "old.txt"]);
    expect(await view.listChangedPaths(ws.commitId, ws.parentCommitId))
        .toStrictEqual(["notes.txt", "old.txt"]);
    expect(await view.listChangedPaths(ws.commitId, ws.commitId)).toStrictEqual([]);
  }));

  it("list 20 commits of a longer history when no depth is given", () => withWorkspace(async ws => {
    // A line of 22 commits, a second apart. Any stored commit can start a log, so it needs no
    // gadget.
    let oids: string[] = [];
    for (let step = 1; step <= 22; step++) {
      oids.push(await commitFiles(ws, { "step.txt": `${step}\n` }, {
        parents: oids.slice(-1), message: `step ${step}`,
        timestamp: new Date(1700000000_000 + step * 1000),
      }));
    }
    let tip = oids.at(-1)!;
    let newestFirst = oids.toReversed();

    let view = await open(ws);
    let log = await view.getCommitLog(tip);
    expect(log).toHaveLength(DEFAULT_ADMIN_COMMIT_LOG_DEPTH);
    // The workspace stores each commit's message, and the view answers with none of them.
    expect(ws.impl.gitCache.readCommitLog(tip, { depth: 20 }).at(-1).message).toBe("step 3\n");
    expect(log.map(commit => [commit.oid, commit.message]))
        .toStrictEqual(newestFirst.slice(0, 20).map(oid => [oid, ""]));
    expect((await view.getCommitLog(tip, 21)).map(commit => commit.oid))
        .toStrictEqual(newestFirst.slice(0, 21));
    let whole = await view.getCommitLog(tip, MAX_ADMIN_COMMIT_LOG_DEPTH);
    expect(whole.map(commit => commit.oid)).toStrictEqual(newestFirst);

    // A record keeps the depth as its caller gave it, not the one the read applied.
    let records = (await deploymentRecords(ws)).filter(r => r.method === "getCommitLog");
    expect(records.map(r => [r.args, r.access])).toStrictEqual([
      [{ fromCommit: tip }, "metadata"],
      [{ fromCommit: tip, depth: 21 }, "metadata"],
      [{ fromCommit: tip, depth: MAX_ADMIN_COMMIT_LOG_DEPTH }, "metadata"],
    ]);
  }));

  it("refuse, unrecorded, a depth outside the log's bounds", () => withWorkspace(async ws => {
    let view = await open(ws);
    for (let depth of [0, MAX_ADMIN_COMMIT_LOG_DEPTH + 1, 1.5]) {
      await expect(view.getCommitLog(ws.commitId, depth)).rejects.toThrow(TypeError);
      await expect(view.getCommitLog(ws.commitId, depth)).rejects.toThrow(
          `The commit log's depth must be a whole number from 1 to ${MAX_ADMIN_COMMIT_LOG_DEPTH}.`);
    }
    expect((await deploymentRecords(ws)).map(r => r.method)).toStrictEqual(["inspectWorkspace"]);
  }));

  it("record an id that names no stored commit as a read that failed",
      () => withWorkspace(async ws => {
    let view = await open(ws);
    let tree = ws.impl.gitCache.commitTree(ws.commitId);
    let blob = ws.impl.gitCache.localPathEntryAtCommit(ws.commitId, "notes.txt").oid;

    await expect(view.getCommitLog("not-an-oid")).rejects.toThrow("Invalid commit id.");
    await expect(view.listFilesAtCommit(MISSING_PARENT))
        .rejects.toThrow(noStoredCommit(MISSING_PARENT));
    await expect(view.listChangedPaths(ws.commitId, blob)).rejects.toThrow(noStoredCommit(blob));
    await expect(view.listChangedPaths(MISSING_PARENT, ws.commitId))
        .rejects.toThrow(noStoredCommit(MISSING_PARENT));
    await expect(view.getCommitLog(tree)).rejects.toThrow(noStoredCommit(tree));

    let records = (await deploymentRecords(ws)).slice(1);
    expect(records.map(r => [r.method, r.args, r.access])).toStrictEqual([
      ["getCommitLog", { fromCommit: "not-an-oid" }, "metadata"],
      ["listFilesAtCommit", { commitId: MISSING_PARENT }, "metadata"],
      ["listChangedPaths", { fromCommit: ws.commitId, toCommit: blob }, "metadata"],
      ["listChangedPaths", { fromCommit: MISSING_PARENT, toCommit: ws.commitId }, "metadata"],
      ["getCommitLog", { fromCommit: tree }, "metadata"],
    ]);
    for (let record of records) expect(record).not.toHaveProperty("refused");
  }));

  it("never pull a missing object through a connection", () => withWorkspace(async ws => {
    let view = await open(ws);
    let gitCache = ws.impl.gitCache;

    // A parent a connection could serve ends the walk, unasked.
    let pulls = forbidPulls(ws, MISSING_PARENT, "commit");
    expect((await view.getCommitLog(ws.orphanCommitId)).map(commit => commit.oid))
        .toStrictEqual([ws.orphanCommitId]);
    expect(pulls.pulled).toBe(false);

    let root = gitCache.commitTree(ws.parentCommitId);
    pulls = forbidPulls(ws, root, "tree");
    await expect(view.listFilesAtCommit(ws.parentCommitId)).rejects.toThrow(missingObject(root));
    await expect(view.listChangedPaths(ws.parentCommitId, ws.commitId))
        .rejects.toThrow(missingObject(root));
    expect(pulls.pulled).toBe(false);

    // The head's own parent, once it is gone: the head lists alone.
    pulls = forbidPulls(ws, ws.parentCommitId, "commit");
    expect((await view.getCommitLog(ws.commitId)).map(commit => commit.oid))
        .toStrictEqual([ws.commitId]);
    expect(pulls.pulled).toBe(false);
  }));
});

describe("a chat's pending changes", () => {
  it("list what the chat changed against its pin's base", () => withWorkspace(async ws => {
    let view = await open(ws);
    expect(await view.listPendingChanges(DRAFT_CHAT_ID)).toStrictEqual([seededPendingChange(ws)]);
    // A chat that changed nothing holds no changes.
    expect(await view.listPendingChanges(CHAT_ID)).toStrictEqual([]);

    // A gadget the chat created, not accepted yet: no pin, so no base, and every file is added.
    let created = ws.impl.createGadget("Sketch", "SKETCH", DRAFT_CHAT_ID);
    await agentStep(ws, DRAFT_CHAT_ID,
        { [created.id]: [["main.js", { set: "code\n" }], ["lib/util.js", { set: "util\n" }]] });
    expect(await view.listPendingChanges(DRAFT_CHAT_ID)).toStrictEqual([
      seededPendingChange(ws),
      { gadgetId: created.id, added: ["lib/util.js", "main.js"], modified: [], removed: [] },
    ]);
  }));

  it("list one side of an accept whole, never the chat's files against the pins it cleared",
      async () => {
    // An accept clears the chat's pins in a synchronous tail, which can run in the microtask
    // between the fold settling and the listing going on. The accept is started first and the
    // listing a growing number of microtasks later, so that some offset lands in that gap: the
    // listing then folds a second time, which is counted so that the sweep cannot miss the gap
    // unnoticed.
    let refolded = false;
    for (let ticks = 0; ticks <= 16; ticks++) {
      await withWorkspace(async ws => {
        let view = await open(ws);
        // Only the view passes a base reader, so these are its folds and not the accept's.
        let folds = 0;
        let fold = ws.impl.getCurrentChatContent.bind(ws.impl);
        ws.impl.getCurrentChatContent = (...args: unknown[]) => {
          if (args[2] !== undefined) folds++;
          return fold(...args);
        };
        let merge = ws.impl.mergeChanges(DRAFT_CHAT_ID, { profile: OWNER }, OWNER_USER_ID);
        for (let i = 0; i < ticks; i++) await Promise.resolve();
        let listing = await view.listPendingChanges(DRAFT_CHAT_ID);
        expect((await merge).outcome).toBe("merged");
        expect([[seededPendingChange(ws)], []], `${ticks} microtasks after the accept began`)
            .toContainEqual(listing);
        refolded ||= folds > 1;
      });
    }
    expect(refolded).toBe(true);
  });

  it("record an id that names no chat as a read that failed", () => withWorkspace(async ws => {
    let view = await open(ws);
    await expect(view.listPendingChanges(999)).rejects.toThrow("No such chatId: 999");

    let records = (await deploymentRecords(ws)).slice(1);
    expect(records.map(r => [r.method, r.args, r.access])).toStrictEqual([
      ["listPendingChanges", { chatId: 999 }, "metadata"],
    ]);
    for (let record of records) expect(record).not.toHaveProperty("refused");
  }));

  it("fold a worktree's changes from stored objects alone", () => withWorkspace(async ws => {
    let view = await open(ws);
    let { id, baseCommit } = await addWorktreeChat(ws);
    // A view opened for content, under a grant, reads the files of the same fold.
    allowContent(ws);
    let grant = putGrant(ws);
    let content = await openForContent(ws);

    // same.txt, edited back to its base text, is in no list.
    expect(await view.listPendingChanges(WORKTREE_CHAT_ID)).toStrictEqual([{
      gadgetId: id, baseCommit, mergedCommit: baseCommit,
      added: ["new.txt"], modified: ["a.txt"], removed: ["gone.txt"],
    }]);
    expect(await content.readPendingFile(WORKTREE_CHAT_ID, id, "a.txt"))
        .toStrictEqual({ kind: "text", text: "one!\n" });
    expect(await content.readPendingFile(WORKTREE_CHAT_ID, id, "gone.txt"))
        .toStrictEqual({ kind: "absent" });
    // A file the chat never touched is not in its content: it reads at the base.
    expect(await content.readPendingFile(WORKTREE_CHAT_ID, id, "src/untouched.txt"))
        .toStrictEqual({ kind: "absent" });
    expect(await content.readFileAtCommit(baseCommit, "src/untouched.txt"))
        .toStrictEqual({ kind: "text", text: "kept\n" });

    // Without the edited file's base text the fold fails, and asks no connection for it.
    let base = ws.impl.gitCache.localPathEntryAtCommit(baseCommit, "a.txt").oid;
    let pulls = forbidPulls(ws, base, "blob");
    ws.impl.invalidateChatContent(WORKTREE_CHAT_ID);
    await expect(view.listPendingChanges(WORKTREE_CHAT_ID))
        .rejects.toThrow(missingObject(base));
    await expect(content.readPendingFile(WORKTREE_CHAT_ID, id, "a.txt"))
        .rejects.toThrow(missingObject(base));
    expect(pulls.pulled).toBe(false);
    // Each a read that failed: recorded, not as a refusal, and as having exposed nothing.
    let records = (await deploymentRecords(ws)).slice(-2);
    expect(records.map(r => [r.method, r.requested, r.exposed, r.grantId, r.refused]))
        .toStrictEqual([
          ["listPendingChanges", "metadata", "metadata", undefined, undefined],
          ["readPendingFile", "content", "metadata", grant.id, undefined],
        ]);
  }));

  it("never pull a worktree's base to tell its paths apart", () => withWorkspace(async ws => {
    let view = await open(ws);
    let { baseCommit } = await addWorktreeChat(ws);
    // With the chat's content folded, a listing still reads the base's tree, which says what
    // each path the chat touched was there.
    await view.listPendingChanges(WORKTREE_CHAT_ID);
    let root = ws.impl.gitCache.commitTree(baseCommit);
    let pulls = forbidPulls(ws, root, "tree");
    await expect(view.listPendingChanges(WORKTREE_CHAT_ID)).rejects.toThrow(missingObject(root));
    expect(pulls.pulled).toBe(false);
  }));

  it("list a file the chat holds as bytes by what it holds", () => withWorkspace(async ws => {
    let view = await open(ws);
    let { id, baseCommit } = await addWorktreeChat(ws);
    let bytes = new Uint8Array([0x00, 0xff, 0x10, 0x80, 0x7f]);
    // Bytes also replace two of the base's files: same.txt with other bytes, and
    // src/untouched.txt with the very bytes it holds there, which changes nothing.
    let set = (content: Uint8Array) => ({ setBytes: ws.impl.gitCache.writeBlob(content) });
    await agentStep(ws, WORKTREE_CHAT_ID, { [id]: [
      ["data.bin", set(bytes)], ["same.txt", set(bytes)],
      ["src/untouched.txt", set(new TextEncoder().encode("kept\n"))],
    ] });

    expect(await view.listPendingChanges(WORKTREE_CHAT_ID)).toStrictEqual([{
      gadgetId: id, baseCommit, mergedCommit: baseCommit,
      added: ["data.bin", "new.txt"], modified: ["a.txt", "same.txt"], removed: ["gone.txt"],
    }]);
  }));

  it("list workpieces by id and paths by name, in whatever order the chat changed them",
      () => withWorkspace(async ws => {
    let view = await open(ws);
    // The chat changes its worktree before the seeded gadget, whose id is the lower one, and the
    // worktree's paths in descending order: two modified, two removed and two added. A scratch
    // file the base lacks, written and then removed, is in no list.
    let { id, baseCommit } = await addWorktree(ws,
        { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n", "d.txt": "d\n" });
    await agentStep(ws, WORKTREE_CHAT_ID, editChange(id, "d.txt", "d\n", "d!\n"));
    await submit(ws, WORKTREE_CHAT_ID, { [id]: [
      ["c.txt", { set: "c!\n" }], ["b.txt", { remove: true }], ["a.txt", { remove: true }],
      ["z.txt", { set: "z\n" }], ["y.txt", { set: "y\n" }], ["tmp.txt", { set: "t\n" }],
    ] });
    await submit(ws, WORKTREE_CHAT_ID, { [id]: [["tmp.txt", { remove: true }]] });
    await submit(ws, WORKTREE_CHAT_ID, { [ws.gadgetId]: [["notes.txt", { set: "notes!\n" }]] },
        [{ gadgetId: ws.gadgetId, baseCommit: ws.commitId }]);

    expect(await view.listPendingChanges(WORKTREE_CHAT_ID)).toStrictEqual([
      {
        gadgetId: ws.gadgetId, baseCommit: ws.commitId, mergedCommit: ws.commitId,
        added: [], modified: ["notes.txt"], removed: [],
      },
      {
        gadgetId: id, baseCommit, mergedCommit: baseCommit,
        added: ["y.txt", "z.txt"], modified: ["c.txt", "d.txt"], removed: ["a.txt", "b.txt"],
      },
    ]);
  }));

  it("leave out what a revert took back, and list what the chat changed after it",
      () => withWorkspace(async ws => {
    let view = await open(ws);
    // The second of two steps is reverted, so what it touched is no longer the chat's: b.txt,
    // which it removed, is in no list. A revert also starts the chat's stream of changes over,
    // and the removal of c.txt is a row of the stream that follows it.
    let { id, baseCommit } = await addWorktree(ws,
        { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
    await agentStep(ws, WORKTREE_CHAT_ID, editChange(id, "a.txt", "a\n", "a!\n"));
    await agentStep(ws, WORKTREE_CHAT_ID,
        { [id]: [["b.txt", { remove: true }], ["n.txt", { set: "n\n" }]] });
    let reverted = [...ws.impl.storage.chats.list()]
        .findLast(msg => msg.chatId === WORKTREE_CHAT_ID && msg.type === "changes")!.sequence;
    await ws.impl.revertChanges(WORKTREE_CHAT_ID, reverted, OWNER);
    await submit(ws, WORKTREE_CHAT_ID, { [id]: [["c.txt", { remove: true }]] });

    expect(await view.listPendingChanges(WORKTREE_CHAT_ID)).toStrictEqual([{
      gadgetId: id, baseCommit, mergedCommit: baseCommit,
      added: [], modified: ["a.txt"], removed: ["c.txt"],
    }]);
  }));

  it("list a pin rooted at a merge commit against that commit", () => withWorkspace(async ws => {
    let impl = ws.impl;
    let view = await open(ws);
    // The gadget's head moves on to a child that adds a file. A pin does not follow the head.
    let moved = await commitFiles(ws,
        { "notes.txt": `${WITHHELD.file}\n`, "todo.txt": "todo\n", "other.txt": "other\n" },
        { parents: [ws.commitId], message: "other" });
    impl.storage.gadgets.put({ ...impl.storage.gadgets.get(ws.gadgetId), commitId: moved });
    expect(await view.listPendingChanges(DRAFT_CHAT_ID)).toStrictEqual([seededPendingChange(ws)]);

    // An update from mainline roots the pin at a merge of the head and the chat's files. The chat
    // has changed nothing on top of it, while accepting would still change the gadget: by what
    // differs between the head it merged and the merge.
    expect(await impl.updateChatFromMainline(DRAFT_CHAT_ID, OWNER))
        .toStrictEqual({ conflictPaths: [] });
    let [rooted] = await view.listPendingChanges(DRAFT_CHAT_ID);
    let merge = rooted.baseCommit!;
    expect([ws.commitId, moved]).not.toContain(merge);
    expect(rooted).toStrictEqual({
      gadgetId: ws.gadgetId, baseCommit: merge, mergedCommit: moved,
      added: [], modified: [], removed: [],
    });
    expect((await view.getCommitLog(merge, 1))[0].parents[0]).toBe(moved);
    expect(await view.listChangedPaths(moved, merge))
        .toStrictEqual(["added.txt", "notes.txt", "todo.txt"]);

    // What the chat changes next is listed against the merge.
    await submit(ws, DRAFT_CHAT_ID, {
      [ws.gadgetId]: [["other.txt", { set: "other!\n" }], ["more.txt", { set: "more\n" }]],
    });
    expect(await view.listPendingChanges(DRAFT_CHAT_ID)).toStrictEqual([{
      gadgetId: ws.gadgetId, baseCommit: merge, mergedCommit: moved,
      added: ["more.txt"], modified: ["other.txt"], removed: [],
    }]);
  }));

  it("leave out a worktree a step pinned by committing alone, until the content is folded again",
      () => withWorkspace(async ws => {
    let impl = ws.impl;
    let view = await open(ws);
    let { id, baseCommit } = await addWorktree(ws, { "a.txt": "one\n" });
    // The chat has not touched its worktree, so holds no pin for it. This listing folds the
    // chat's content, which the workspace then keeps.
    expect(await view.listPendingChanges(WORKTREE_CHAT_ID)).toStrictEqual([]);
    let before = impl.chatCodeBase(impl.storage.chatMeta.get(WORKTREE_CHAT_ID));
    expect(before.pins).toStrictEqual([]);

    // A step that commits in the worktree and changes no file pins it, and moves neither the
    // generation nor the revision the kept content is held under.
    let commit = await commitFiles(ws, { "a.txt": "committed\n" }, { parents: [baseCommit] });
    await impl.commitAgentStep(WORKTREE_CHAT_ID, AGENT, [{ type: "message", message: "step" }], {
      changes: [], createdGadgets: [], createdWorktrees: [], addedBindings: [],
      worktreeCommits: [{ worktreeId: id, commit, previousHead: baseCommit }],
    });
    let after = impl.chatCodeBase(impl.storage.chatMeta.get(WORKTREE_CHAT_ID));
    expect(after.pins).toStrictEqual([{ gadgetId: id, baseCommit, mergedCommit: baseCommit }]);
    expect([after.generation, after.revision]).toStrictEqual([before.generation, before.revision]);
    expect(await view.listPendingChanges(WORKTREE_CHAT_ID)).toStrictEqual([]);

    // A fresh fold has the pinned worktree, with no path the chat changed.
    impl.invalidateChatContent(WORKTREE_CHAT_ID);
    expect(await view.listPendingChanges(WORKTREE_CHAT_ID)).toStrictEqual([{
      gadgetId: id, baseCommit, mergedCommit: baseCommit, added: [], modified: [], removed: [],
    }]);
  }));

  it("leave out a pin that outlived its workpiece", () => withWorkspace(async ws => {
    let view = await open(ws);
    allowContent(ws);
    let grant = putGrant(ws);
    let content = await openForContent(ws);
    await ws.impl.removeWorkpiece(ws.gadgetId);
    expect(await view.listPendingChanges(DRAFT_CHAT_ID)).toStrictEqual([]);

    // The chat's content still holds the removed workpiece's files, and a content read under a
    // grant returns none of them.
    let held = await ws.impl.getCurrentChatContent(
        DRAFT_CHAT_ID, ws.impl.getChatMetaOrThrow(DRAFT_CHAT_ID));
    expect(held.get(ws.gadgetId)?.get("notes.txt")).toBe("draft notes\n");
    await expect(content.readPendingFile(DRAFT_CHAT_ID, ws.gadgetId, "notes.txt"))
        .rejects.toThrow(`Chat ${DRAFT_CHAT_ID} holds no changes to workpiece ${ws.gadgetId}.`);
    let record = (await deploymentRecords(ws)).at(-1)!;
    expect(record).toMatchObject({
      method: "readPendingFile", access: "content", exposed: "metadata", grantId: grant.id,
    });
    expect(record).not.toHaveProperty("refused");
  }));

  it("fail on a pending edit of a symlink without naming its target",
      () => withWorkspace(async ws => {
    let impl = ws.impl;
    let gitCache = impl.gitCache;
    // A base whose link.md is a symlink. Writing files produces no symlink entry, so the tree is
    // encoded here. The link's target is named nowhere else in the workspace.
    let target = "secret-target.txt";
    let blob = (text: string) => gitCache.writeBlob(new TextEncoder().encode(text)).oid;
    let tree = encodeGitTree([
      { mode: "100644", name: "a.txt", oid: blob("one\n") },
      { mode: "120000", name: "link.md", oid: blob(target) },
    ]);
    gitCache.importObjects([{ type: "tree", payload: tree }]);
    let { id } = await addWorktreeAt(ws, gitCache.writeCommitForTree(gitObjectOid("tree", tree), {
      parents: [], author: COMMITTER, message: "test commit", timestamp: new Date(1700000000_000),
    }));
    // A step's edit of a regular file pins the worktree.
    await agentStep(ws, WORKTREE_CHAT_ID, editChange(id, "a.txt", "one\n", "one!\n"));

    // A member's edit of the link is refused, with an error that names the target.
    let edit = editChange(id, "link.md", "old\n", "new\n");
    await expect(submit(ws, WORKTREE_CHAT_ID, edit))
        .rejects.toThrow(`link.md is a symlink to ${target}`);

    // The same edit as a row of the chat's change stream, where an accepted submission is left.
    let meta = impl.storage.chatMeta.get(WORKTREE_CHAT_ID);
    let revision = meta.codeBase.revision + 1;
    impl.storage.chatChanges.put({
      chatId: WORKTREE_CHAT_ID, generation: meta.codeBase.generation, revision,
      timestamp: new Date(), author: OWNER, change: edit,
    });
    impl.storage.chatMeta.put({ ...meta, codeBase: { ...meta.codeBase, revision } });
    impl.invalidateChatContent(WORKTREE_CHAT_ID);

    let view = await open(ws);
    let error: Error = await view.listPendingChanges(WORKTREE_CHAT_ID).then(
        () => { throw new Error("Expected the listing to fail."); }, err => err);
    expect(error.message).toBe("link.md is a symlink");
    // A read that failed: recorded, and not as a refusal.
    let record = (await deploymentRecords(ws)).at(-1)!;
    expect(record)
        .toMatchObject({ method: "listPendingChanges", args: { chatId: WORKTREE_CHAT_ID } });
    expect(record).not.toHaveProperty("refused");
    expect(String(error) + JSON.stringify(record)).not.toContain(target);
  }));
});

// What a workspace refuses a grant that reaches a connection with no creationSpec.
const LEGACY_CONNECTION = "legacy connection that cannot verify collaborators' access";

describe("sharing reads", () => {
  it("list observers, requirements, share links and rules whole, and blueprints without ids",
      () => withWorkspace(async ws => {
    let storage = ws.impl.storage;
    // Three more observers, each record with every field it stores. Carol's is reserved: her
    // first admission has verified nothing. One of Dave's choices is for a connection since
    // removed. The stranger has no collaborator record.
    let carol: AiChatAuthorInfo = { type: "user", id: "carol@example.test", name: "Carol" };
    let dave: AiChatAuthorInfo = { type: "user", id: "dave@example.test", name: "Dave" };
    for (let profile of [carol, dave]) {
      storage.collaborators.put({
        profile,
        addedBy: [{ type: "user", sharer: OWNER.id, created: new Date(0), role: "build" }],
      });
    }
    storage.observers.put(
        { profileId: carol.id, observerId: "observer-carol", accountChoices: {} });
    storage.observers.put({
      profileId: dave.id, observerId: "observer-dave",
      accountChoices: { 99: 9, [GATEKEEPER_ID]: 8 },
    });
    storage.observers.put({
      profileId: STRANGER_ID, observerId: "observer-stranger",
      accountChoices: { [AMBIENT_GATEKEEPER_ID]: 4 },
    });
    // By profile id, each choice by connection id. An entry has its two fields and a choice its
    // three: never the record's observer id, and a removed connection's choice has no vendor.
    let observers = [
      ...seededObservers(),
      { profile: carol, accountChoices: [] },
      {
        profile: dave,
        accountChoices: [
          { gatekeeperId: GATEKEEPER_ID, accountId: 8, vendorId: "testvendor" },
          { gatekeeperId: 99, accountId: 9, vendorId: undefined },
        ],
      },
      {
        profile: { type: "user", id: STRANGER_ID, name: STRANGER_ID },
        accountChoices: [
          { gatekeeperId: AMBIENT_GATEKEEPER_ID, accountId: 4, vendorId: "library" },
        ],
      },
    ];

    let view = await open(ws);
    expect(await view.listObservers()).toStrictEqual(observers);
    // An ambient connection has a vendor, so a collaborator needs an account for it too. The
    // gadget reaches only the connection it binds. The vendor is spelled as the connection's
    // creationSpec spells it, where listObservers() and listGatekeepers() give it in lower case.
    expect(await view.listObserverRequirements("workspace"))
        .toStrictEqual([REPO_REQUIREMENT, LIBRARY_REQUIREMENT]);
    expect(await view.listObserverRequirements({ gadgetId: ws.gadgetId }))
        .toStrictEqual([REPO_REQUIREMENT]);
    // Each link with its note, role and creator (the owner's profile, the collaborator's, and
    // one made of an id), under its id: a link's record holds no key.
    expect(await view.listShareLinks()).toStrictEqual(seededShareLinks(ws));
    expect(await view.listAutoApprovals()).toStrictEqual(seededAutoApprovals());
    expect((await view.listGatekeepers()).map(({ id, createdBy }) => [id, createdBy]))
        .toStrictEqual([[GATEKEEPER_ID, OWNER], [AMBIENT_GATEKEEPER_ID, undefined]]);
    // The workspace's members are listed the blueprint under its id, with the screenshot URL
    // that holds it. The view lists neither.
    expect(ws.impl.blueprintSummaries()).toStrictEqual([{
      ...seededBlueprint(), id: BLUEPRINT_ID,
      screenshotUrl: `/blueprint-screenshot/${BLUEPRINT_ID}?v=5000`,
    }]);
    expect(await view.listBlueprints()).toStrictEqual([seededBlueprint()]);
  }));

  it("list a rule that applies nothing, beside what says why", () => withWorkspace(async ws => {
    ws.impl.storage.containsRestrictedData.put(true);
    let view = await open(ws);
    // The rule stays stored, and listed, once the workspace has read restricted data, and
    // describe() reports that it has.
    expect(await view.listAutoApprovals()).toStrictEqual(seededAutoApprovals());
    expect((await view.describe()).containsRestrictedData).toBe(true);
    // An action keeps its author's verdict and its kind, beside its emptied description.
    let { entries } = await view.listActions();
    expect(entries.find(entry => entry.type === "action")!.description).toMatchObject({
      description: "", autoApprovable: true, actionKind: { tag: "edit", label: "Edits" },
    });
  }));

  it("list the gadgets of a link to several, as the workspace's members are listed them",
      () => withWorkspace(async ws => {
    let impl = ws.impl;
    let storage = impl.storage;
    let board = impl.createGadget("Board", "BOARD", undefined, undefined, ws.commitId);
    // Two gadgets the link cannot grant: one still provisional to a chat, and one removed.
    let pending = impl.createGadget("Sketch", "SKETCH", IDLE_CHAT_ID);
    let removedId = impl.allocateWorkpieceId();
    // No such link can be created, so its record is stored as the migration that froze it to
    // its gadgets left it. A key copied from the link since is stored under the key's hash.
    let linkId = "e5".repeat(32);
    let copiedKeyHash = "f6".repeat(32);
    storage.shareKeys.put({
      id: linkId, note: "Everything", created: new Date(4000), createdBy: BOB.id, role: "use",
      gadgetIds: [ws.gadgetId, board.id, pending.id, removedId],
    });
    storage.shareKeys.put({ id: copiedKeyHash, alias: linkId });

    let view = await open(ws);
    let links = await view.listShareLinks();
    let frozen = links.at(-1)!;
    expect(links).toStrictEqual([...seededShareLinks(ws), {
      linkId, note: "Everything", created: new Date(4000), createdBy: BOB, role: "use",
      gadgets: [{ id: ws.gadgetId, title: "Notes" }, { id: board.id, title: "Board" }],
    }]);
    expect(frozen).not.toHaveProperty("gadgetId");
    // A link is listed under its id, and no answer holds the hash of a key copied from it.
    expect(JSON.stringify(links)).not.toContain(copiedKeyHash);
    // What a member's session lists, which reads the owner's profile from their account.
    expect(links).toStrictEqual(await impl.shareLinkInfos(() => impl.users.get().whoami()));
  }));

  it("ask the owner's account for a share link's creator only when the owner created one",
      () => withWorkspace(async ws => {
    let storage = ws.impl.storage;
    let user = ws.impl.users.get();
    let asked = 0;
    ws.impl.users = {
      idFromString: (id: string) => id,
      get: () => ({ ...user, whoami: async () => { asked++; return OWNER; } }),
    };
    // A second link of the owner's: one lookup serves both.
    storage.shareKeys.put(
        { id: "d4".repeat(32), created: new Date(4000), createdBy: OWNER.id, role: "build" });
    let view = await open(ws);
    expect(asked).toBe(0);

    let links = await view.listShareLinks();
    expect(links.map(link => link.createdBy.id))
        .toStrictEqual([OWNER.id, BOB.id, STRANGER_ID, OWNER.id]);
    expect(asked).toBe(1);

    // With none of the links the owner's, their account is not asked at all.
    storage.shareKeys.delete(OWNER_LINK_ID);
    storage.shareKeys.delete("d4".repeat(32));
    asked = 0;
    expect((await view.listShareLinks()).map(link => link.linkId))
        .toStrictEqual([BOB_LINK_ID, STRANGER_LINK_ID]);
    expect(asked).toBe(0);
  }));

  it("record a grant whose requirements cannot be listed as a read that failed",
      () => withWorkspace(async ws => {
    let impl = ws.impl;
    let view = await open(ws);
    // A connection made before connections could verify collaborators, which no gadget binds.
    let legacyId = impl.allocateWorkpieceId();
    impl.storage.gatekeepers.put({ id: legacyId, resourceTitle: "Old", class: {} as any });

    await expect(view.listObserverRequirements({ gadgetId: 999 }))
        .rejects.toThrow("No such gadget: 999");
    // "workspace" reaches every connection, so the legacy one fails it.
    await expect(view.listObserverRequirements("workspace")).rejects.toThrow(LEGACY_CONNECTION);
    // The gadget does not reach it, so its grant answers.
    expect(await view.listObserverRequirements({ gadgetId: ws.gadgetId }))
        .toStrictEqual([REPO_REQUIREMENT]);
    // Once the gadget binds it, the gadget's grant fails as well.
    let gadget = impl.storage.gadgets.get(ws.gadgetId);
    impl.storage.gadgets.put(
        { ...gadget, bindings: { ...gadget.bindings, OLD: { target: legacyId } } });
    await expect(view.listObserverRequirements({ gadgetId: ws.gadgetId }))
        .rejects.toThrow(LEGACY_CONNECTION);

    let records = (await deploymentRecords(ws)).slice(1);
    expect(records.map(r => [r.method, r.args, r.access])).toStrictEqual([
      ["listObserverRequirements", { gadgetId: 999 }, "metadata"],
      ["listObserverRequirements", { grant: "workspace" }, "metadata"],
      ["listObserverRequirements", { gadgetId: ws.gadgetId }, "metadata"],
      ["listObserverRequirements", { gadgetId: ws.gadgetId }, "metadata"],
    ]);
    for (let record of records) expect(record).not.toHaveProperty("refused");
  }));

  it("never reach a connection", () => withWorkspace(async ws => {
    let reached = 0;
    ws.impl.getGatekeeperFacet = () => {
      reached++;
      throw new Error("an admin read reached a connection");
    };
    let view = await open(ws);
    await view.listGatekeepers();
    await view.listObservers();
    await view.listObserverRequirements("workspace");
    await view.listObserverRequirements({ gadgetId: ws.gadgetId });
    await view.listShareLinks();
    await view.listAutoApprovals();
    await view.listBlueprints();
    await view.getDiagnostics();
    expect(reached).toBe(0);
  }));
});

// One call of each mixed method on the seed, in the audit's order.
async function mixedAnswers(ws: Workspace, view: AdminWorkspaceView) {
  return {
    describe: await view.describe(),
    listChats: await view.listChats(),
    getChatState: await view.getChatState(CHAT_ID),
    listActions: await view.listActions(),
    getCommitLog: await view.getCommitLog(ws.commitId),
    listGatekeepers: await view.listGatekeepers(),
    listBlueprints: await view.listBlueprints(),
  };
}

// What the seed stores of each thing a mixed method returns under a grant and withholds without
// one. The rest of WITHHELD is what only a content read returns (a message, a file) and what
// no method of the view returns (a call's raw arguments).
const MIXED_CONTENT = [
  WITHHELD.steer, WITHHELD.callSummary, WITHHELD.observation, WITHHELD.observationLabel,
  WITHHELD.observationValue, WITHHELD.action, WITHHELD.actionLabel, WITHHELD.actionValue,
  WITHHELD.hookEntry, WITHHELD.hook, WITHHELD.configuration, WITHHELD.upstream,
  WITHHELD.headMessage, WITHHELD.parentMessage, BLUEPRINT_ID, "/blueprint-screenshot/",
];

describe("a content view", () => {
  it.each([
    ["a live grant in the workspace", (ws: Workspace) => { putGrant(ws); }],
    ["a live account-wide grant", (ws: Workspace) => { ws.account.answer = () => accountGrant(); }],
    ["no grant anywhere", () => {}],
  ])("is opened without a grant being looked for, with %s", (_case, arrange) =>
      withWorkspace(async ws => {
    allowContent(ws);
    arrange(ws);
    let expiresAt = new Date(Date.now() + 600_000);
    let view = await openForContent(ws, { expiresAt });

    expect(ws.account.asked).toStrictEqual([]);
    // Strictly: the open's record carries no grant, the workspace's live one included.
    expect(await deploymentRecords(ws)).toStrictEqual([{
      kind: "workspace", workspaceId: ws.id, workspaceOwner: OWNER.id, at: expect.any(Date),
      admin: ADMIN, sessionId: "session-1", via: "api", workspaceTitle: "Quarterly plan",
      method: "inspectWorkspace", args: { expiresAt: expiresAt.toISOString() }, reason: REASON,
      requested: "content", access: "content", exposed: "metadata",
    }]);

    // The first call that could return content is the one that looks: in the workspace's own
    // storage, and in the owner's account only when that holds no live grant.
    await view.listChats();
    expect(ws.account.asked).toStrictEqual(grantKeys(ws).length ? [] : [OWNER_USER_ID]);
  }));

  it("answers with metadata alone, unrefused, while no grant is live",
      () => withWorkspace(async ws => {
    seedTurn(ws);
    let withheld = await mixedAnswers(ws, await open(ws));
    allowContent(ws);
    let view = await openForContent(ws);
    let answers = await mixedAnswers(ws, view);

    // As a metadata view answers, but for what the view says of itself.
    let { expiresAt } = answers.describe;
    expect(answers).toStrictEqual(
        { ...withheld, describe: { ...withheld.describe, access: "content", expiresAt } });
    let records = (await deploymentRecords(ws)).slice(-MIXED_METHODS.length);
    expect(records.map(r => [r.method, r.requested, r.access, r.exposed, r.refused]))
        .toStrictEqual(MIXED_METHODS.map(
            method => [method, "content", "content", "metadata", undefined]));
    for (let record of records) expect(record).not.toHaveProperty("grantId");
    // An answer that there is no grant is not kept: each call asked the owner's account.
    expect(ws.account.asked).toStrictEqual(MIXED_METHODS.map(() => OWNER_USER_ID));
  }));

  it("returns what metadata withholds under a grant in the workspace, and records it",
      () => withWorkspace(async ws => {
    seedTurn(ws);
    addIdleChat(ws);
    allowContent(ws);
    let grant = putGrant(ws);
    let view = await openForContent(ws);
    let answers = await everyAnswer(ws, view);

    let answered = JSON.stringify(answers);
    for (let sentinel of MIXED_CONTENT) expect(answered, sentinel).toContain(sentinel);
    // What only a content read returns stays out, a message and a file, and so does what no
    // method of the view returns, a call's raw arguments.
    for (let sentinel of [WITHHELD.message, WITHHELD.callArgument, WITHHELD.file]) {
      expect(answered, sentinel).not.toContain(sentinel);
    }

    expect((await seededChat(view)).queuedSteers)
        .toStrictEqual([{ text: WITHHELD.steer, author: OWNER }]);
    expect(answers.getChatState).toStrictEqual(seededChatState(ws, true));
    expect(answers.describe.access).toBe("content");
    expect(answers.describe.grants).toStrictEqual([grant]);
    expect(answers.describe.workpieces.find(w => w.id === ws.gadgetId))
        .toMatchObject({ upstream: { blueprintId: WITHHELD.upstream } });
    let action = answers.listActions.entries.find(entry => entry.type === "action")!;
    expect(action.description).toMatchObject({
      description: WITHHELD.action,
      fields: [{ label: WITHHELD.actionLabel, value: WITHHELD.actionValue }],
    });
    expect(answers.getCommitLog.map(commit => commit.message.trim()))
        .toStrictEqual([WITHHELD.headMessage, WITHHELD.parentMessage]);
    let [gatekeeper] = answers.listGatekeepers;
    expect(gatekeeper.creationSpec).toMatchObject({ configuration: WITHHELD.configuration });
    expect(gatekeeper.hooks.map(hook => hook.description.description))
        .toStrictEqual([WITHHELD.hook]);
    expect(answers.listBlueprints.map(blueprint => blueprint.id)).toStrictEqual([BLUEPRINT_ID]);

    // Answers that hold nothing "metadata" withholds: the call ran under the grant all the same.
    expect((await view.listActions({ beforeId: 0 })).entries).toStrictEqual([]);
    expect((await view.getChatState(IDLE_CHAT_ID)).queuedCalls).toStrictEqual([]);
    ws.impl.storage.blueprints.delete(BLUEPRINT_ID);
    expect(await view.listBlueprints()).toStrictEqual([]);

    let records = (await deploymentRecords(ws)).slice(1);
    expect(records.map(r => [r.method, r.exposed, r.grantId])).toStrictEqual([
      ...NON_CONTENT_METHODS.filter(method => method !== "inspectWorkspace").map(method =>
          ADMIN_METHOD_ANSWERS[method] === "mixed"
              ? [method, "content", grant.id] : [method, "metadata", undefined]),
      // seededChat()'s listing.
      ["listChats", "content", grant.id],
      ["listActions", "metadata", grant.id],
      ["getChatState", "metadata", grant.id],
      ["listBlueprints", "metadata", grant.id],
    ]);
    for (let record of records) {
      expect(record).toMatchObject({ requested: "content", access: "content" });
      expect(record).not.toHaveProperty("refused");
      expect("grantId" in record, record.method)
          .toBe(ADMIN_METHOD_ANSWERS[record.method] === "mixed");
    }
    // The workspace's own grant answers: the owner's account is not asked.
    expect(ws.account.asked).toStrictEqual([]);
  }));

  it("returns metadata alone through a view opened for metadata, whatever grant is live",
      () => withWorkspace(async ws => {
    seedTurn(ws);
    allowContent(ws);
    let grant = putGrant(ws);
    ws.account.answer = () => accountGrant();
    let view = await open(ws);
    let answered = JSON.stringify(await everyAnswer(ws, view));
    for (let sentinel of Object.values(WITHHELD)) expect(answered, sentinel).not.toContain(sentinel);

    // Nor does it ask the owner's account when the workspace holds no grant of its own.
    ws.impl.storage.adminGrants.delete(grant.id);
    await mixedAnswers(ws, view);
    expect(ws.account.asked).toStrictEqual([]);
    for (let record of await deploymentRecords(ws)) {
      expect(record).toMatchObject({ requested: "metadata", access: "content", exposed: "metadata" });
      expect(record).not.toHaveProperty("grantId");
    }
  }));

  it("never looks for a grant for a method that answers with metadata alone",
      () => withWorkspace(async ws => {
    allowContent(ws);
    ws.account.answer = () => accountGrant();
    let view = await openForContent(ws);
    await view.listChatAttachments(CHAT_ID);
    await view.listFiles(ws.gadgetId);
    await view.listFilesAtCommit(ws.parentCommitId);
    await view.listChangedPaths(ws.parentCommitId, ws.commitId);
    await view.listPendingChanges(DRAFT_CHAT_ID);
    await view.listObservers();
    await view.listObserverRequirements("workspace");
    await view.listShareLinks();
    await view.listAutoApprovals();
    await view.getDiagnostics();

    expect(ws.account.asked).toStrictEqual([]);
    let records = (await deploymentRecords(ws)).slice(1);
    expect(records.map(r => r.method)).toStrictEqual(METADATA_METHODS);
    for (let record of records) {
      expect(record).toMatchObject({ requested: "content", access: "content", exposed: "metadata" });
      expect(record).not.toHaveProperty("grantId");
    }
  }));

  it("withholds from its very next call once the grant is revoked, or has expired",
      () => withWorkspace(async ws => {
    allowContent(ws);
    let view = await openForContent(ws);
    let revoked = putGrant(ws);
    expect((await seededChat(view)).queuedSteers).toBeDefined();
    ws.impl.storage.adminGrants.put({ ...revoked, revokedAt: new Date(), revokedBy: OWNER });
    expect(await seededChat(view)).not.toHaveProperty("queuedSteers");

    let expired = putGrant(ws);
    expect((await seededChat(view)).queuedSteers).toBeDefined();
    ws.impl.storage.adminGrants.put({ ...expired, expiresAt: new Date(Date.now() - 1) });
    expect(await seededChat(view)).not.toHaveProperty("queuedSteers");

    expect((await deploymentRecords(ws)).slice(1).map(r => [r.exposed, r.grantId]))
        .toStrictEqual([
          ["content", revoked.id], ["metadata", undefined],
          ["content", expired.id], ["metadata", undefined],
        ]);
  }));

  it("withholds from its next call once the level in force is below content, looking for no grant",
      () => withWorkspace(async ws => {
    allowContent(ws);
    ws.account.answer = () => accountGrant();
    let view = await openForContent(ws);
    expect((await seededChat(view)).queuedSteers).toBeDefined();
    expect(ws.account.asked).toHaveLength(1);

    // The admins' choice drops, with the grant still live.
    ws.config.adminWorkspaceAccess = "metadata";
    expect(await seededChat(view)).not.toHaveProperty("queuedSteers");
    // So does the cap, whatever the admins chose.
    ws.config.adminWorkspaceAccess = "content";
    setEnv(ws);
    expect(await seededChat(view)).not.toHaveProperty("queuedSteers");
    expect(ws.account.asked).toHaveLength(1);

    allowContent(ws);
    expect((await seededChat(view)).queuedSteers).toBeDefined();

    let records = (await deploymentRecords(ws)).slice(1);
    expect(records.map(r => [r.requested, r.access, r.exposed, "grantId" in r])).toStrictEqual([
      ["content", "content", "content", true],
      ["content", "metadata", "metadata", false],
      ["content", "metadata", "metadata", false],
      ["content", "content", "content", true],
    ]);
  }));

  it("records a read that fails under a grant as an attempt that exposed no content",
      () => withWorkspace(async ws => {
    allowContent(ws);
    let grant = putGrant(ws);
    let view = await openForContent(ws);
    await expect(view.getChatState(999)).rejects.toThrow();
    expect((await deploymentRecords(ws)).at(-1)).toMatchObject({
      method: "getChatState", args: { chatId: 999 }, exposed: "metadata", grantId: grant.id,
    });
  }));
});

// Runs `fn` with the clock held still, moved only by the `advance` it is handed.
async function withClock(fn: (advance: (ms: number) => void) => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    await fn(ms => { vi.setSystemTime(Date.now() + ms); });
  } finally {
    vi.useRealTimers();
  }
}

// Initialises an unseeded workspace far enough for its owner to open a session on it: an owner
// whose account answers whoami() with `profile`, and the seed's chat with its queued steer.
function initForOwnerSession(ws: Workspace, profile: AiChatAuthorInfo = OWNER): void {
  let impl = ws.impl;
  impl.directories = {
    getByName: () => ({ syncWorkspace: async () => {}, removeWorkspace: async () => {} }),
  };
  impl.users = {
    idFromString: (id: string) => id,
    idFromName: (name: string) => name,
    get: (id: string) => ({
      id, whoami: async () => profile,
      liveAccountAdminGrant: async () => {
        ws.account.asked.push(id);
        return ws.account.answer();
      },
      listGatekeeperVendors: async () => [], setWorkspaceLastActive: async () => {},
      recordSharedWorkspaceOpen: async () => {}, workspaceRemoved: async () => {},
      messageArrived: async () => {}, getWorkspace: async () => null,
      getGadget: async () => null, syncWorkspaceOutputs: async () => {},
    }),
  };
  // The side effects of opening that reach outside the workspace.
  impl.ensureAmbientCapsules = async () => {};
  impl.markOutputsDirty = () => {};
  impl.scheduleAccessRestart = async () => {};
  impl.ownerId = OWNER_USER_ID;
  impl.ownerProfileId = profile.id;
  impl.storage.ownerId.put(OWNER_USER_ID);
  impl.storage.title.put("Quarterly plan");
  impl.storage.chatMeta.put({
    id: CHAT_ID, title: "Plans", started: new Date(0), lastActive: new Date(0),
    queuedSteers: [{ text: WITHHELD.steer, author: OWNER }],
  });
}

// Runs `fn` over a real owner session on a workspace initForOwnerSession() set up.
async function asOwner<T>(ws: Workspace, fn: (client: Overseer) => Promise<T>): Promise<T> {
  // Disposed with the session: the session holds a duplicate of the stub until then.
  using notifyClosed = new NativeRpcStub<() => void>(() => {});
  using client = await ws.instance.open(OWNER_USER_ID, OWNER.id, notifyClosed);
  return await fn(client);
}

// Whether a listChats() through `view` returned the seeded chat's queued steers: content.
async function readsContent(view: AdminWorkspaceView): Promise<boolean> {
  return (await seededChat(view)).queuedSteers !== undefined;
}

describe("the owner's account-wide grant", () => {
  it("is asked for once, relied on for a minute, and never copied into the workspace",
      () => withWorkspace(ws => withClock(async advance => {
    initForOwnerSession(ws);
    allowContent(ws);
    let grant = accountGrant();
    ws.account.answer = () => grant;
    let view = await openForContent(ws);

    expect(await readsContent(view)).toBe(true);
    advance(30_000);
    expect(await readsContent(view)).toBe(true);
    expect(ws.account.asked).toStrictEqual([OWNER_USER_ID]);

    // The workspace stores no grant: neither its admins' listing nor its owner's holds one.
    expect(grantKeys(ws)).toStrictEqual([]);
    expect((await view.describe()).grants).toStrictEqual([]);
    expect(await asOwner(ws, client => client.listAdminGrants())).toStrictEqual([]);
    expect((await deploymentRecords(ws)).slice(1).map(r => [r.method, r.exposed, r.grantId]))
        .toStrictEqual([
          ["listChats", "content", grant.id], ["listChats", "content", grant.id],
          // Nothing "metadata" withholds from this workspace's description.
          ["describe", "metadata", grant.id],
        ]);

    // The owner ends it. The workspace relies on what it was told until that is a minute old.
    ws.account.answer = () => null;
    advance(ADMIN_GRANT_ACCOUNT_CACHE_SECONDS * 1000 - 30_001);
    expect(await readsContent(view)).toBe(true);
    expect(ws.account.asked).toHaveLength(1);
    advance(1);
    expect(await readsContent(view)).toBe(false);
    expect(ws.account.asked).toHaveLength(2);
    expect((await deploymentRecords(ws)).at(-1)).not.toHaveProperty("grantId");
    expect(grantKeys(ws)).toStrictEqual([]);
  }), { seed: false }));

  it("covers a workspace made after it was given", () => withWorkspace(async ws => {
    allowContent(ws);
    let grant = accountGrant({ grantedAt: new Date(Date.now() - 3_600_000) });
    ws.account.answer = () => grant;
    expect(await readsContent(await openForContent(ws))).toBe(true);
    expect((await deploymentRecords(ws)).at(-1)).toMatchObject({ grantId: grant.id });
  }));

  it("is found by the next call once it is given: an answer that there is none is not kept",
      () => withWorkspace(async ws => {
    allowContent(ws);
    let view = await openForContent(ws);
    expect(await readsContent(view)).toBe(false);
    expect(await readsContent(view)).toBe(false);
    expect(ws.account.asked).toHaveLength(2);

    let grant = accountGrant();
    ws.account.answer = () => grant;
    expect(await readsContent(view)).toBe(true);
    expect(ws.account.asked).toHaveLength(3);
    expect((await deploymentRecords(ws)).slice(1).map(r => [r.exposed, r.grantId]))
        .toStrictEqual([["metadata", undefined], ["metadata", undefined], ["content", grant.id]]);
  }));

  it.each<[string, () => unknown]>([
    ["a grant of one workspace", () => accountGrant({ scope: "workspace" })],
    ["a grant a second admin approved", () => accountGrant({ source: "admins" })],
    ["a grant whose end is not a time", () => accountGrant({ expiresAt: new Date(NaN) })],
    ["a grant whose end is not a Date",
     () => accountGrant({ expiresAt: "2999-01-01T00:00:00.000Z" as never })],
    ["a grant of a level that is not content", () => accountGrant({ level: "all" as never })],
    ["a grant already revoked", () => accountGrant({ revokedAt: new Date(0) })],
    ["a grant already expired", () => accountGrant({ expiresAt: new Date(Date.now() - 1) })],
    ["something that is not a grant", () => "yes"],
    ["nothing", () => undefined],
  ])("is not taken on the account's word: %s is no grant, and is not kept", (_case, answer) =>
      withWorkspace(async ws => {
    allowContent(ws);
    ws.account.answer = answer;
    let view = await openForContent(ws);
    expect(await readsContent(view)).toBe(false);
    expect(await readsContent(view)).toBe(false);
    expect(ws.account.asked).toHaveLength(2);
    for (let record of (await deploymentRecords(ws)).slice(1)) {
      expect(record).toMatchObject({ method: "listChats", exposed: "metadata" });
      expect(record).not.toHaveProperty("grantId");
      expect(record).not.toHaveProperty("refused");
    }
  }));

  it("counts as none while the account cannot answer, and the call is still answered and recorded",
      () => withWorkspace(async ws => {
    allowContent(ws);
    let view = await openForContent(ws);

    // A reset is retried once, and the retry fails too.
    ws.account.answer = () => {
      throw Object.assign(new Error("The Durable Object was reset."), { durableObjectReset: true });
    };
    expect(await readsContent(view)).toBe(false);
    expect(ws.account.asked).toHaveLength(2);
    // Any other failure is not retried.
    ws.account.answer = () => { throw new Error("account unavailable"); };
    expect(await readsContent(view)).toBe(false);
    expect(ws.account.asked).toHaveLength(3);
    for (let record of (await deploymentRecords(ws)).slice(1)) {
      expect(record).toMatchObject({ method: "listChats", access: "content", exposed: "metadata" });
      expect(record).not.toHaveProperty("grantId");
      expect(record).not.toHaveProperty("refused");
    }

    // Nothing was kept of the failures: the next call asks again, and reads content.
    let grant = accountGrant();
    ws.account.answer = () => grant;
    expect(await readsContent(view)).toBe(true);
    expect(ws.account.asked).toHaveLength(4);
    expect((await deploymentRecords(ws)).at(-1)).toMatchObject(
        { exposed: "content", grantId: grant.id });
  }));

  it("is not relied on past its own end, inside the minute",
      () => withWorkspace(ws => withClock(async advance => {
    allowContent(ws);
    let grant = accountGrant({ expiresAt: new Date(Date.now() + 10_000) });
    ws.account.answer = () => grant;
    let view = await openForContent(ws);
    expect(await readsContent(view)).toBe(true);
    advance(9_999);
    expect(await readsContent(view)).toBe(true);
    expect(ws.account.asked).toHaveLength(1);

    // The account answering with the ended grant again changes nothing.
    advance(1);
    expect(await readsContent(view)).toBe(false);
    expect(ws.account.asked).toHaveLength(2);
  })));

  it("is relied on for a minute from when the question was sent, not from its answer",
      () => withWorkspace(ws => withClock(async advance => {
    allowContent(ws);
    let grant = accountGrant();
    // The account takes 20 seconds to answer.
    ws.account.answer = () => {
      advance(20_000);
      return grant;
    };
    let view = await openForContent(ws);
    expect(await readsContent(view)).toBe(true);

    ws.account.answer = () => null;
    advance(ADMIN_GRANT_ACCOUNT_CACHE_SECONDS * 1000 - 20_001);
    expect(await readsContent(view)).toBe(true);
    expect(ws.account.asked).toHaveLength(1);
    // A minute after the question, 40 seconds after the answer.
    advance(1);
    expect(await readsContent(view)).toBe(false);
    expect(ws.account.asked).toHaveLength(2);
  })));

  it("is kept for the owner it was asked of, and dropped when the workspace is deleted",
      () => withWorkspace(async ws => {
    allowContent(ws);
    const NEXT_OWNER_USER_ID = "next-owner-user-do";
    let first = accountGrant();
    let second = accountGrant();
    ws.account.answer = () => ws.account.asked.at(-1) === OWNER_USER_ID ? first : second;
    let view = await openForContent(ws);
    expect(await readsContent(view)).toBe(true);

    // The workspace is another owner's: what the first owner's account said is not used.
    ws.impl.ownerId = NEXT_OWNER_USER_ID;
    ws.impl.storage.ownerId.put(NEXT_OWNER_USER_ID);
    expect(await readsContent(view)).toBe(true);
    expect(ws.account.asked).toStrictEqual([OWNER_USER_ID, NEXT_OWNER_USER_ID]);
    expect((await deploymentRecords(ws)).slice(1).map(r => r.grantId))
        .toStrictEqual([first.id, second.id]);

    // Kept until the workspace is deleted: its id can live again under an owner.
    expect(await ws.impl.contentGrant()).toStrictEqual(second);
    expect(ws.account.asked).toHaveLength(2);
    ws.impl.beginDeletion(new Set());
    ws.impl.ownerId = NEXT_OWNER_USER_ID;
    expect(await ws.impl.contentGrant()).toStrictEqual(second);
    expect(ws.account.asked).toHaveLength(3);
  }));

  it.each<[string, number, (ws: Workspace) => Promise<void>, string]>([
    ["the workspace's deletion", 600_000, async ws => {
      await ws.state.storage.deleteAll();
      ws.impl.ownerId = undefined;
    }, ADMIN_ACCESS_ERROR_CODES.workspaceNotFound],
    ["the view's expiry", SHORT_LIFETIME_MS,
     () => scheduler.wait(SHORT_LIFETIME_MS + 100), ADMIN_ACCESS_ERROR_CODES.viewExpired],
    ["its admin's demotion", 600_000, async ws => {
      setEnv(ws, { ADMIN_WORKSPACE_ACCESS_MAX: "content", ADMINS: ["someone-else@example.test"] });
    }, ADMIN_ACCESS_ERROR_CODES.notAdmin],
  ])("writes nothing for a call that %s overtakes while it asks", (_case, lifetime, overtake, code) =>
      withWorkspace(async ws => {
    allowContent(ws);
    let view = await openForContent(ws, { expiresAt: new Date(Date.now() + lifetime) });
    let reach!: () => void;
    let reached = new Promise<void>(resolve => { reach = resolve; });
    let release!: () => void;
    let released = new Promise<void>(resolve => { release = resolve; });
    ws.account.answer = async () => {
      reach();
      await released;
      return accountGrant();
    };

    let call = view.listChats();
    await reached;
    await overtake(ws);
    release();

    expect(await codeOf(call)).toBe(code);
    expect((await deploymentRecords(ws)).map(r => r.method)).toStrictEqual(["inspectWorkspace"]);
  }));
});

// A live grant given `minutesAgo`, by the owner or by a second admin's approval, so that a test's
// grants have an order.
function grantGiven(ws: Workspace, minutesAgo: number, source: "owner" | "admins" = "owner") {
  let grantedAt = new Date(Date.now() - minutesAgo * 60_000);
  return putGrant(ws, source === "owner" ? { grantedAt } : {
    ...newAdminGrant({
      source: "admins", scope: "workspace", grantedBy: { id: "grace@example.test", name: "Grace" },
      requestedBy: ADMIN, requestId: `request-${minutesAgo}`, reason: REASON,
    }),
    grantedAt,
  });
}

describe("the grants a view lists", () => {
  it("are the newest of the live ones, bounded, on a view opened for metadata too",
      () => withWorkspace(async ws => {
    allowContent(ws);
    let grants = Array.from({ length: 30 }, (_, i) => grantGiven(ws, i));
    putGrant(ws, { revokedAt: new Date(), revokedBy: OWNER });
    putGrant(ws, { expiresAt: new Date(Date.now() - 1) });

    let listed = (await (await open(ws)).describe()).grants;
    expect(listed).toStrictEqual(grants.slice(0, MAX_ADMIN_GRANTS_LISTED));
    expect(MAX_ADMIN_GRANTS_LISTED).toBe(20);

    // Any live one lets content be read, listed or not.
    let view = await openForContent(ws);
    expect(await readsContent(view)).toBe(true);
    expect((await deploymentRecords(ws)).at(-1)).toMatchObject({ grantId: grants[0].id });
    expect((await view.describe()).grants).toStrictEqual(listed);
  }));

  it("hold a grant only an admin can end ahead of every owner grant, however old it is",
      () => withWorkspace(async ws => {
    let owners = Array.from({ length: 20 }, (_, i) => grantGiven(ws, i));
    let approved = grantGiven(ws, 600, "admins");
    expect((await (await open(ws)).describe()).grants)
        .toStrictEqual([approved, ...owners.slice(0, MAX_ADMIN_GRANTS_LISTED - 1)]);
  }));

  it("order the admins' grants newest first, then the owner's", () => withWorkspace(async ws => {
    let older = grantGiven(ws, 30, "admins");
    let owner = grantGiven(ws, 1);
    let newer = grantGiven(ws, 10, "admins");
    expect((await (await open(ws)).describe()).grants).toStrictEqual([newer, older, owner]);
  }));

  it("stay small whatever the owner's name", () => withWorkspace(async ws => {
    let name = "n".repeat(1_000_000);
    initForOwnerSession(ws, { ...OWNER, name });
    allowContent(ws);
    await asOwner(ws, async client => {
      for (let i = 0; i < 30; i++) await client.grantAdminAccess();
    });

    let description = await (await open(ws)).describe();
    expect(description.grants).toHaveLength(MAX_ADMIN_GRANTS_LISTED);
    for (let grant of description.grants) {
      expect(grant.grantedBy).toStrictEqual(
          { id: OWNER.id, name: `${"n".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH - 1)}…` });
    }
    expect(JSON.stringify(description.grants).length).toBeLessThan(64 * 1024);
    // The description holds the name once, in the owner's profile, and not once a grant.
    expect(description.owner.name).toBe(name);
    expect(JSON.stringify(description).length).toBeLessThan(name.length + 64 * 1024);
  }, { seed: false }));
});

type ContentMethod = typeof CONTENT_METHODS[number];

// One call of each content read on the seed, by method, each started only when it is asked for:
// the seeded chat's page, its blob-backed attachment, the head's notes.txt, a file only the head's
// parent holds, and a file the draft chat added.
function contentReads(ws: Workspace, view: AdminWorkspaceView)
    : Record<ContentMethod, () => Promise<unknown>> {
  return {
    getChat: () => view.getChat(CHAT_ID),
    readChatAttachment: () => view.readChatAttachment(CHAT_ID, BLOB_ATTACHMENT_ID),
    readFile: () => view.readFile(ws.gadgetId, "notes.txt"),
    readFileAtCommit: () => view.readFileAtCommit(ws.parentCommitId, "old.txt"),
    readPendingFile: () => view.readPendingFile(DRAFT_CHAT_ID, ws.gadgetId, "added.txt"),
  };
}

// What contentReads() records as each call's arguments.
function contentReadArgs(ws: Workspace): Record<ContentMethod, AdminAccessRecord["args"]> {
  return {
    getChat: { chatId: CHAT_ID },
    readChatAttachment: { chatId: CHAT_ID, id: BLOB_ATTACHMENT_ID },
    readFile: { gadgetId: ws.gadgetId, path: "notes.txt" },
    readFileAtCommit: { commitId: ws.parentCommitId, path: "old.txt" },
    readPendingFile: { chatId: DRAFT_CHAT_ID, gadgetId: ws.gadgetId, path: "added.txt" },
  };
}

// A stream read to its end.
async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The bytes of a file a content read returned as a stream, failing the test for any other kind.
async function streamedBytes(file: AdminFileContent): Promise<Uint8Array> {
  if (file.kind !== "stream") throw new Error(`Expected a stream, got "${file.kind}".`);
  return await bytesOf(file.content);
}

// `size` bytes that no run of zeroes or of one value makes up, so that a chunk misplaced or
// repeated shows.
function patternBytes(size: number): Uint8Array {
  let bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + (i >>> 8)) & 0xff;
  return bytes;
}

// Watches every way the content reads could reach the workspace's content: the page builder's
// rows, an attachment's stream and a file read.
function watchReads(ws: Workspace) {
  return [
    vi.spyOn(ws.impl, "getChatMetaOrThrow"),
    vi.spyOn(ws.impl, "hydrateChatMessageForClient"),
    vi.spyOn(ws.impl, "openChatAttachment"),
    vi.spyOn(ws.impl.gitCache, "readLocalFileAtCommit"),
    vi.spyOn(ws.impl, "getCurrentChatContent"),
  ];
}

describe("a content read", () => {
  it("is refused, recorded, through a view opened for metadata, even while a grant is live",
      () => withWorkspace(async ws => {
    allowContent(ws);
    putGrant(ws);
    ws.account.answer = () => accountGrant();
    let view = await open(ws);
    let reads = watchReads(ws);

    for (let method of CONTENT_METHODS) {
      expect(await codeOf(contentReads(ws, view)[method]()), method)
          .toBe(ADMIN_ACCESS_ERROR_CODES.contentNotRequested);
    }
    let records = (await deploymentRecords(ws)).slice(1);
    expect(records.map(r => [r.method, r.args, r.requested, r.access, r.exposed, r.refused]))
        .toStrictEqual(CONTENT_METHODS.map(method => [
          method, contentReadArgs(ws)[method], "metadata", "content", "metadata",
          ADMIN_ACCESS_ERROR_CODES.contentNotRequested,
        ]));
    for (let record of records) expect(record).not.toHaveProperty("grantId");
    // Refused before anything was read or asked.
    for (let read of reads) expect(read).not.toHaveBeenCalled();
    expect(ws.account.asked).toStrictEqual([]);
  }));

  it("is refused, recorded, while the level in force is below content, the account never asked",
      () => withWorkspace(async ws => {
    allowContent(ws);
    putGrant(ws);
    ws.account.answer = () => accountGrant();
    let view = await openForContent(ws);
    let reads = watchReads(ws);

    // The admins' choice drops, then the cap, each with both grants still live.
    let lower: (() => void)[] = [
      () => { ws.config.adminWorkspaceAccess = "metadata"; },
      () => { ws.config.adminWorkspaceAccess = "content"; setEnv(ws); },
    ];
    for (let drop of lower) {
      allowContent(ws);
      drop();
      for (let method of CONTENT_METHODS) {
        expect(await codeOf(contentReads(ws, view)[method]()), method)
            .toBe(ADMIN_ACCESS_ERROR_CODES.contentOff);
      }
    }
    let records = (await deploymentRecords(ws)).slice(1);
    expect(records.map(r => [r.method, r.args, r.requested, r.access, r.exposed, r.refused]))
        .toStrictEqual([...CONTENT_METHODS, ...CONTENT_METHODS].map(method => [
          method, contentReadArgs(ws)[method], "content", "metadata", "metadata",
          ADMIN_ACCESS_ERROR_CODES.contentOff,
        ]));
    for (let record of records) expect(record).not.toHaveProperty("grantId");
    for (let read of reads) expect(read).not.toHaveBeenCalled();
    expect(ws.account.asked).toStrictEqual([]);

    // Back at "content", the same view reads again.
    allowContent(ws);
    expect(await view.readFile(ws.gadgetId, "notes.txt"))
        .toStrictEqual({ kind: "text", text: `${WITHHELD.file}\n` });
  }));

  it("is refused, recorded, while no grant is live", () => withWorkspace(async ws => {
    allowContent(ws);
    // Grants that have ended are not live.
    putGrant(ws, { revokedAt: new Date(), revokedBy: OWNER });
    putGrant(ws, { expiresAt: new Date(Date.now() - 1) });
    let view = await openForContent(ws);
    let reads = watchReads(ws);

    for (let method of CONTENT_METHODS) {
      expect(await codeOf(contentReads(ws, view)[method]()), method)
          .toBe(ADMIN_ACCESS_ERROR_CODES.grantRequired);
    }
    let records = (await deploymentRecords(ws)).slice(1);
    expect(records.map(r => [r.method, r.args, r.requested, r.access, r.exposed, r.refused]))
        .toStrictEqual(CONTENT_METHODS.map(method => [
          method, contentReadArgs(ws)[method], "content", "content", "metadata",
          ADMIN_ACCESS_ERROR_CODES.grantRequired,
        ]));
    for (let record of records) expect(record).not.toHaveProperty("grantId");
    for (let read of reads) expect(read).not.toHaveBeenCalled();
    // Each call asked the owner's account: an answer that there is none is not kept.
    expect(ws.account.asked).toStrictEqual(CONTENT_METHODS.map(() => OWNER_USER_ID));
  }));

  it("is refused, recorded, while the owner's account cannot answer, and answers under a " +
      "workspace grant without asking it", () => withWorkspace(async ws => {
    allowContent(ws);
    ws.account.answer = () => { throw new Error("account unavailable"); };
    let view = await openForContent(ws);

    for (let method of CONTENT_METHODS) {
      expect(await codeOf(contentReads(ws, view)[method]()), method)
          .toBe(ADMIN_ACCESS_ERROR_CODES.grantRequired);
    }
    // Never an unrecorded failure: each refusal is in the log.
    expect((await deploymentRecords(ws)).slice(1).map(r => [r.method, r.refused, r.grantId]))
        .toStrictEqual(CONTENT_METHODS.map(
            method => [method, ADMIN_ACCESS_ERROR_CODES.grantRequired, undefined]));
    expect(ws.account.asked).toHaveLength(CONTENT_METHODS.length);

    let grant = putGrant(ws);
    for (let method of CONTENT_METHODS) await contentReads(ws, view)[method]();
    expect(ws.account.asked).toHaveLength(CONTENT_METHODS.length);
    expect((await deploymentRecords(ws)).slice(-CONTENT_METHODS.length)
        .map(r => [r.method, r.exposed, r.grantId, r.refused]))
        .toStrictEqual(CONTENT_METHODS.map(method => [method, "content", grant.id, undefined]));
  }));

  it.each(CONTENT_METHODS)(
      "%s uses an account-wide grant given just after it was refused", method =>
      withWorkspace(async ws => {
    allowContent(ws);
    let view = await openForContent(ws);
    expect(await codeOf(contentReads(ws, view)[method]()))
        .toBe(ADMIN_ACCESS_ERROR_CODES.grantRequired);

    let grant = accountGrant();
    ws.account.answer = () => grant;
    await contentReads(ws, view)[method]();
    expect(ws.account.asked).toHaveLength(2);
    expect((await deploymentRecords(ws)).slice(1).map(r => [r.method, r.exposed, r.grantId, r.refused]))
        .toStrictEqual([
          [method, "metadata", undefined, ADMIN_ACCESS_ERROR_CODES.grantRequired],
          [method, "content", grant.id, undefined],
        ]);
  }));

  it("returns nothing when its record cannot be written", () => withWorkspace(async ws => {
    allowContent(ws);
    putGrant(ws);
    let view = await openForContent(ws);
    ws.impl.adminAudits = {
      getByName: () => ({ append: async () => { throw new Error("audit store down"); } }),
    };
    for (let method of CONTENT_METHODS) {
      await expect(contentReads(ws, view)[method](), method).rejects.toThrow("audit store down");
    }
    // A refusal whose record cannot be written fails the same way, never as the refusal.
    for (let grant of ws.impl.storage.adminGrants.list()) {
      ws.impl.storage.adminGrants.delete(grant.id);
    }
    for (let method of CONTENT_METHODS) {
      await expect(contentReads(ws, view)[method](), method).rejects.toThrow("audit store down");
    }
    expect((await deploymentRecords(ws)).map(r => r.method)).toStrictEqual(["inspectWorkspace"]);
  }));
});

// Three MiB: over MAX_BUFFERED_BLOB_SIZE, so a file or an attachment of this size is one the
// server must not hold whole.
const LARGE_SIZE = 3 * 1024 * 1024;
const LARGE_ATTACHMENT_ID = "88888888-8888-4888-8888-888888888888";
const IMAGE_ATTACHMENT_ID = "99999999-9999-4999-8999-999999999999";

// Watches the reads that hold a blob whole. The function it returns fails the test if one was
// made since: a whole read of a blob by oid, of an attachment, or of an object that turned out
// to be a blob (commits and trees are read whole), or one read of more than
// MAX_BUFFERED_BLOB_SIZE bytes from a blob opened to be read in pieces.
function watchWholeReads(ws: Workspace): () => void {
  let readBlob = vi.spyOn(ws.impl.gitCache, "readBlob");
  let readObject = vi.spyOn(ws.impl.gitCache, "readLocalObject");
  let attachmentData = vi.spyOn(ws.impl, "getChatAttachmentData");
  let readPiece = vi.spyOn(BlobReader.prototype, "read");
  return () => {
    let pieces = readPiece.mock.calls.map(([, length]) => length);
    readPiece.mockRestore();
    expect(readBlob).not.toHaveBeenCalled();
    expect(attachmentData).not.toHaveBeenCalled();
    expect(readObject.mock.results.map(result => result.value?.type)).not.toContain("blob");
    expect(pieces.filter(length => length > MAX_BUFFERED_BLOB_SIZE)).toStrictEqual([]);
  };
}

describe("content reads under a grant", () => {
  it.each<[string, (ws: Workspace) => AdminAccessGrant]>([
    ["a grant in the workspace", ws => putGrant(ws)],
    ["an account-wide grant alone", ws => {
      let grant = accountGrant();
      ws.account.answer = () => grant;
      return grant;
    }],
  ])("answer under %s, each record saying what it exposed", (_case, arrange) =>
      withWorkspace(async ws => {
    addIdleChat(ws);
    allowContent(ws);
    let grant = arrange(ws);
    let view = await openForContent(ws);

    let page = await view.getChat(CHAT_ID);
    expect(page.messages.map(msg => msg.type === "message" ? msg.message : msg.type))
        .toStrictEqual([WITHHELD.message, "see attached"]);
    expect(page.compacted).toBeUndefined();
    expect(await bytesOf(await view.readChatAttachment(CHAT_ID, BLOB_ATTACHMENT_ID)))
        .toStrictEqual(BLOB_ATTACHMENT_BYTES);
    expect(await view.readFile(ws.gadgetId, "notes.txt"))
        .toStrictEqual({ kind: "text", text: `${WITHHELD.file}\n` });
    expect(await view.readFileAtCommit(ws.parentCommitId, "old.txt"))
        .toStrictEqual({ kind: "text", text: "dropped\n" });
    expect(await view.readPendingFile(DRAFT_CHAT_ID, ws.gadgetId, "added.txt"))
        .toStrictEqual({ kind: "text", text: "added\n" });

    // Answers that hold no content: the calls ran under the grant all the same.
    expect(await view.getChat(IDLE_CHAT_ID)).toStrictEqual({ messages: [], compacted: undefined });
    expect(await view.readFile(ws.gadgetId, "nowhere.txt")).toStrictEqual({ kind: "absent" });
    expect(await view.readFileAtCommit(ws.commitId, "old.txt")).toStrictEqual({ kind: "absent" });
    // A path the chat removed.
    expect(await view.readPendingFile(DRAFT_CHAT_ID, ws.gadgetId, "todo.txt"))
        .toStrictEqual({ kind: "absent" });

    let records = (await deploymentRecords(ws)).slice(1);
    expect(records.map(r => [r.method, r.args, r.exposed])).toStrictEqual([
      ...CONTENT_METHODS.map(method => [method, contentReadArgs(ws)[method], "content"]),
      ["getChat", { chatId: IDLE_CHAT_ID }, "metadata"],
      ["readFile", { gadgetId: ws.gadgetId, path: "nowhere.txt" }, "metadata"],
      ["readFileAtCommit", { commitId: ws.commitId, path: "old.txt" }, "metadata"],
      ["readPendingFile", { chatId: DRAFT_CHAT_ID, gadgetId: ws.gadgetId, path: "todo.txt" },
       "metadata"],
    ]);
    for (let record of records) {
      expect(record).toMatchObject(
          { requested: "content", access: "content", grantId: grant.id });
      expect(record).not.toHaveProperty("refused");
    }
    // The workspace's own grant answers without the owner's account. An account-wide one is
    // asked for once, and relied on for the calls that follow within the minute.
    expect(ws.account.asked).toStrictEqual(grantKeys(ws).length ? [] : [OWNER_USER_ID]);
  }));

  it("page a chat back by sequence, past the boundary of a compaction",
      () => withWorkspace(async ws => {
    let impl = ws.impl;
    allowContent(ws);
    let grant = putGrant(ws);
    let view = await openForContent(ws);

    // A chat that was never compacted is one page, which a bound cuts short.
    let whole = await view.getChat(CHAT_ID);
    expect(whole.messages.map(msg => msg.sequence)).toStrictEqual([0, 1]);
    expect(whole.compacted).toBeUndefined();
    let bounded = await view.getChat(CHAT_ID, 1);
    expect(bounded.messages.map(msg => msg.sequence)).toStrictEqual([0]);
    expect(bounded.compacted).toBeUndefined();

    // A checkpoint that summarized the first message, published as a compaction publishes one.
    let summary = "The owner laid out the quarter's plan.";
    impl.storage.chatCompactions.put(
        { chatId: CHAT_ID, compactedTo: 1, summary, chatBindings: [], nextChangeId: 0 });
    impl.storage.chatMeta.put({ ...impl.storage.chatMeta.get(CHAT_ID), compactedTo: 1 });

    // The newest page starts at the boundary and carries the summary of what came before it.
    let newest = await view.getChat(CHAT_ID);
    expect(newest.messages.map(msg => msg.sequence)).toStrictEqual([1]);
    expect(newest.compacted).toStrictEqual({ to: 1, summary, proposedChange: undefined });
    // The page below the boundary is the span the checkpoint summarized, in the stored words.
    let earlier = await view.getChat(CHAT_ID, 1);
    expect(earlier.messages.map(msg => [msg.sequence, msg.type === "message" && msg.message]))
        .toStrictEqual([[0, WITHHELD.message]]);
    expect(earlier.compacted).toBeUndefined();

    let unbounded = { chatId: CHAT_ID };
    let below = { chatId: CHAT_ID, beforeSequence: 1 };
    expect((await deploymentRecords(ws)).slice(1)
        .map(r => [r.method, r.args, r.exposed, r.grantId, r.refused]))
        .toStrictEqual([unbounded, below, unbounded, below].map(
            args => ["getChat", args, "content", grant.id, undefined]));
  }));

  it("never copy an account-wide grant into the workspace", () => withWorkspace(async ws => {
    initForOwnerSession(ws);
    allowContent(ws);
    let grant = accountGrant();
    ws.account.answer = () => grant;
    let view = await openForContent(ws);
    for (let method of CONTENT_METHODS) await contentReads(ws, view)[method]();
    expect((await deploymentRecords(ws)).slice(1).map(r => [r.method, r.exposed, r.grantId]))
        .toStrictEqual(CONTENT_METHODS.map(method => [method, "content", grant.id]));

    expect(grantKeys(ws)).toStrictEqual([]);
    expect([...ws.impl.storage.adminGrants.list()]).toStrictEqual([]);
    expect((await view.describe()).grants).toStrictEqual([]);
    expect(await asOwner(ws, client => client.listAdminGrants())).toStrictEqual([]);
  }));

  it("end on the very next call once the grant is revoked, while a stream already returned " +
      "reads to its end", () => withWorkspace(async ws => {
    let impl = ws.impl;
    let bytes = patternBytes(LARGE_SIZE);
    impl.storage.chatAttachmentContent.put({
      fileId: LARGE_ATTACHMENT_ID,
      state: { type: "committed", chatId: CHAT_ID, oid: impl.gitCache.writeBlob(bytes).oid },
    });
    allowContent(ws);
    let grant = putGrant(ws);
    let view = await openForContent(ws);

    let stream = await view.readChatAttachment(CHAT_ID, LARGE_ATTACHMENT_ID);
    impl.storage.adminGrants.put({ ...grant, revokedAt: new Date(), revokedBy: OWNER });
    for (let method of CONTENT_METHODS) {
      expect(await codeOf(contentReads(ws, view)[method]()), method)
          .toBe(ADMIN_ACCESS_ERROR_CODES.grantRequired);
    }
    // The first call was recorded whole before its stream was returned.
    let read = await bytesOf(stream);
    expect(read.byteLength === bytes.byteLength && read.every((byte, i) => byte === bytes[i]))
        .toBe(true);
    expect((await deploymentRecords(ws)).slice(1).map(r => [r.method, r.exposed, r.grantId, r.refused]))
        .toStrictEqual([
          ["readChatAttachment", "content", grant.id, undefined],
          ...CONTENT_METHODS.map(method =>
              [method, "metadata", undefined, ADMIN_ACCESS_ERROR_CODES.grantRequired]),
        ]);
  }));

  it("stream a large file and a large attachment, holding neither whole",
      () => withWorkspace(async ws => {
    let impl = ws.impl;
    let large = patternBytes(LARGE_SIZE);
    let binary = new Uint8Array([0x00, 0xff, 0x10, 0x80, 0x7f, 0x01, 0x02, 0x03, 0x04, 0x05]);
    let largeRef = impl.gitCache.writeBlob(large);
    let commitId = await impl.gitCache.writeFilesAsCommit(new Map<string, unknown>([
      ["large.bin", largeRef], ["small.bin", impl.gitCache.writeBlob(binary)],
      ["small.txt", "ten bytes\n"],
    ]), { parents: [], author: COMMITTER, message: "files", timestamp: new Date(1700000000_000) });
    let gadget = impl.createGadget("Files", "FILES", undefined, undefined, commitId);
    impl.storage.chatAttachmentContent.put({
      fileId: LARGE_ATTACHMENT_ID,
      state: { type: "committed", chatId: CHAT_ID, oid: largeRef.oid },
    });
    allowContent(ws);
    putGrant(ws);
    let view = await openForContent(ws);
    let noneWhole = watchWholeReads(ws);
    let same = (read: Uint8Array) =>
        read.byteLength === large.byteLength && read.every((byte, i) => byte === large[i]);

    for (let file of [
      await view.readFile(gadget.id, "large.bin"),
      await view.readFileAtCommit(commitId, "large.bin"),
    ]) {
      expect(file).toMatchObject({ kind: "stream", byteLength: LARGE_SIZE });
      expect(same(await streamedBytes(file))).toBe(true);
    }
    expect(same(await bytesOf(await view.readChatAttachment(CHAT_ID, LARGE_ATTACHMENT_ID))))
        .toBe(true);
    noneWhole();

    // A file that is not text is a stream whatever its size, and a small text file is text.
    let small = await view.readFile(gadget.id, "small.bin");
    expect(small).toMatchObject({ kind: "stream", byteLength: binary.byteLength });
    expect(await streamedBytes(small)).toStrictEqual(binary);
    expect(await view.readFile(gadget.id, "small.txt"))
        .toStrictEqual({ kind: "text", text: "ten bytes\n" });

    let records = (await deploymentRecords(ws)).slice(1);
    expect(records.map(r => [r.method, r.args.path ?? r.args.id, r.exposed])).toStrictEqual([
      ["readFile", "large.bin", "content"], ["readFileAtCommit", "large.bin", "content"],
      ["readChatAttachment", LARGE_ATTACHMENT_ID, "content"],
      ["readFile", "small.bin", "content"], ["readFile", "small.txt", "content"],
    ]);
  }));

  it("stream each attachment from wherever the workspace stores it", () => withWorkspace(async ws => {
    allowContent(ws);
    putGrant(ws);
    let view = await openForContent(ws);
    let noneWhole = watchWholeReads(ws);
    let stored: [string, Uint8Array][] = [
      [BLOB_ATTACHMENT_ID, BLOB_ATTACHMENT_BYTES], [INLINE_ATTACHMENT_ID, INLINE_ATTACHMENT_BYTES],
      [LEGACY_ATTACHMENT_ID, LEGACY_ATTACHMENT_BYTES],
    ];
    for (let [id, bytes] of stored) {
      expect(await bytesOf(await view.readChatAttachment(CHAT_ID, id)), id).toStrictEqual(bytes);
    }
    noneWhole();
  }));

  it("return a chat's page with no image inlined, where a member's page carries it",
      () => withWorkspace(async ws => {
    initForOwnerSession(ws);
    let impl = ws.impl;
    let image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    let oid = impl.gitCache.writeBlob(image).oid;
    impl.storage.chatAttachmentContent.put({
      fileId: IMAGE_ATTACHMENT_ID,
      state: { type: "committed", chatId: CHAT_ID, oid, workspacePath: "shot.png" },
    });
    let reference = {
      id: IMAGE_ATTACHMENT_ID, oid, mimeType: "image/png", name: "shot.png",
      size: image.byteLength, workspacePath: "shot.png",
    };
    impl.addChatMessages(CHAT_ID, OWNER, [
      { type: "message", message: "a screenshot", attachments: [reference] },
      // An image kept as bytes on its record, whose stored reference holds them too.
      {
        type: "message", message: "an older image",
        attachments: [{
          id: INLINE_ATTACHMENT_ID, mimeType: "image/png", size: INLINE_ATTACHMENT_BYTES.byteLength,
          content: INLINE_ATTACHMENT_BYTES,
        }],
      },
    ]);
    impl.storage.chatAttachmentContent.put({
      fileId: INLINE_ATTACHMENT_ID, data: INLINE_ATTACHMENT_BYTES,
      state: { type: "committed", chatId: CHAT_ID },
    });
    allowContent(ws);
    putGrant(ws);
    let view = await openForContent(ws);

    let noneWhole = watchWholeReads(ws);
    let records = vi.spyOn(impl.storage.chatAttachmentContent, "get");
    let page = await view.getChat(CHAT_ID);
    let attachments = page.messages.flatMap(msg => msg.type === "message" ? msg.attachments ?? [] : []);
    expect(attachments).toStrictEqual([
      reference,
      { id: INLINE_ATTACHMENT_ID, mimeType: "image/png", size: INLINE_ATTACHMENT_BYTES.byteLength },
    ]);
    for (let attachment of attachments) expect(attachment).not.toHaveProperty("content");
    // Neither an image's blob nor its stored bytes were read for the page.
    noneWhole();
    expect(records).not.toHaveBeenCalled();
    records.mockRestore();

    // The bytes are what readChatAttachment() streams.
    expect(await bytesOf(await view.readChatAttachment(CHAT_ID, IMAGE_ATTACHMENT_ID)))
        .toStrictEqual(image);
    expect(await bytesOf(await view.readChatAttachment(CHAT_ID, INLINE_ATTACHMENT_ID)))
        .toStrictEqual(INLINE_ATTACHMENT_BYTES);

    // A member's page of the same chat still carries each image.
    let member = await asOwner(ws, client => client.getChatHistory(CHAT_ID));
    let inlined = member.messages
        .flatMap(msg => msg.type === "message" ? msg.attachments ?? [] : [])
        .map(attachment => attachment.content && new Uint8Array(attachment.content));
    expect(inlined).toStrictEqual([image, INLINE_ATTACHMENT_BYTES]);
  }, { seed: false }));
});

describe("a content read that fails", () => {
  it("is recorded as an attempt that exposed no content", () => withWorkspace(async ws => {
    allowContent(ws);
    let grant = putGrant(ws);
    let view = await openForContent(ws);
    let elsewhere = "44444444-4444-4444-8444-444444444444";
    ws.impl.storage.chatAttachmentContent.put({
      fileId: elsewhere, data: new Uint8Array([1]),
      state: { type: "committed", chatId: DRAFT_CHAT_ID },
    });
    let unknownCommit = "cd".repeat(20);

    await expect(view.getChat(999)).rejects.toThrow("No such chatId: 999");
    await expect(view.readChatAttachment(CHAT_ID, "nope"))
        .rejects.toThrow("Invalid chat attachment ID.");
    // An attachment of another chat is none of this one's.
    await expect(view.readChatAttachment(CHAT_ID, elsewhere))
        .rejects.toThrow("Chat attachment not found.");
    await expect(view.readFile(999, "notes.txt"))
        .rejects.toThrow("No gadget with committed code has id 999.");
    await expect(view.readFileAtCommit(unknownCommit, "notes.txt"))
        .rejects.toThrow(noStoredCommit(unknownCommit));
    await expect(view.readFileAtCommit(ws.commitId, "")).rejects.toThrow();
    await expect(view.readPendingFile(999, ws.gadgetId, "x")).rejects.toThrow("No such chatId: 999");
    await expect(view.readPendingFile(DRAFT_CHAT_ID, 999, "x"))
        .rejects.toThrow(`Chat ${DRAFT_CHAT_ID} holds no changes to workpiece 999.`);

    let records = (await deploymentRecords(ws)).slice(1);
    expect(records.map(r => [r.method, r.args])).toStrictEqual([
      ["getChat", { chatId: 999 }],
      ["readChatAttachment", { chatId: CHAT_ID, id: "nope" }],
      ["readChatAttachment", { chatId: CHAT_ID, id: elsewhere }],
      ["readFile", { gadgetId: 999, path: "notes.txt" }],
      ["readFileAtCommit", { commitId: unknownCommit, path: "notes.txt" }],
      ["readFileAtCommit", { commitId: ws.commitId, path: "" }],
      ["readPendingFile", { chatId: 999, gadgetId: ws.gadgetId, path: "x" }],
      ["readPendingFile", { chatId: DRAFT_CHAT_ID, gadgetId: 999, path: "x" }],
    ]);
    for (let record of records) {
      expect(record).toMatchObject({ access: "content", exposed: "metadata", grantId: grant.id });
      expect(record).not.toHaveProperty("refused");
    }
  }));

  it("never pulls a file's missing object through a connection", () => withWorkspace(async ws => {
    allowContent(ws);
    let grant = putGrant(ws);
    let view = await openForContent(ws);
    let entry = await ws.impl.gitCache.pathEntryAtCommit(ws.commitId, "notes.txt");
    let pulls = forbidPulls(ws, entry.oid, "blob");

    await expect(view.readFile(ws.gadgetId, "notes.txt")).rejects.toThrow(missingObject(entry.oid));
    await expect(view.readFileAtCommit(ws.commitId, "notes.txt"))
        .rejects.toThrow(missingObject(entry.oid));
    let root = await ws.impl.gitCache.pathEntryAtCommit(ws.parentCommitId, "");
    pulls = forbidPulls(ws, root.oid, "tree");
    await expect(view.readFileAtCommit(ws.parentCommitId, "old.txt"))
        .rejects.toThrow(missingObject(root.oid));
    expect(pulls.pulled).toBe(false);

    let records = (await deploymentRecords(ws)).slice(1);
    expect(records.map(r => [r.method, r.exposed, r.grantId])).toStrictEqual([
      ["readFile", "metadata", grant.id], ["readFileAtCommit", "metadata", grant.id],
      ["readFileAtCommit", "metadata", grant.id],
    ]);
    for (let record of records) expect(record).not.toHaveProperty("refused");
  }));

  it("never pulls an attachment's missing object through a connection",
      () => withWorkspace(async ws => {
    allowContent(ws);
    putGrant(ws);
    let view = await openForContent(ws);
    let gitCache = ws.impl.gitCache;
    let missing = "Chat attachment content is missing from Git.";

    let pulls = forbidPulls(ws, ws.attachmentOid, "blob");
    await expect(view.readChatAttachment(CHAT_ID, BLOB_ATTACHMENT_ID))
        .rejects.toThrow("Unknown Git blob.");
    expect(pulls.pulled).toBe(false);

    // The legacy attachment's file, then the tree that names it.
    let { workspaceCommitId } =
        ws.impl.storage.chatAttachmentContent.get(LEGACY_ATTACHMENT_ID).state;
    let file = await gitCache.pathEntryAtCommit(workspaceCommitId, "legacy.pdf");
    let root = await gitCache.pathEntryAtCommit(workspaceCommitId, "");
    pulls = forbidPulls(ws, file.oid, "blob");
    await expect(view.readChatAttachment(CHAT_ID, LEGACY_ATTACHMENT_ID)).rejects.toThrow(missing);
    expect(pulls.pulled).toBe(false);

    pulls = forbidPulls(ws, root.oid, "tree");
    await expect(view.readChatAttachment(CHAT_ID, LEGACY_ATTACHMENT_ID))
        .rejects.toThrow(missingObject(root.oid));
    expect(pulls.pulled).toBe(false);

    let records = (await deploymentRecords(ws)).slice(1);
    expect(records.map(r => [r.method, r.exposed])).toStrictEqual(
        [1, 2, 3].map(() => ["readChatAttachment", "metadata"]));
    for (let record of records) expect(record).not.toHaveProperty("refused");
  }));

  it("reports a legacy attachment whose path names no file as missing from Git",
      () => withWorkspace(async ws => {
    allowContent(ws);
    putGrant(ws);
    let view = await openForContent(ws);
    let gitCache = ws.impl.gitCache;
    let commit = {
      parents: [], author: COMMITTER, message: "attachments", timestamp: new Date(1700000000_000),
    };
    // A commit whose tree holds a directory and a submodule. Writing files produces no submodule
    // entry, so the tree is encoded here.
    let withDir = await gitCache.writeFilesAsCommit(
        new Map([["dir/inner.bin", gitCache.writeBlob(new Uint8Array([0x00, 0x01]))]]), commit);
    let tree = encodeGitTree([
      { mode: "40000", name: "dir", oid: gitCache.localPathEntryAtCommit(withDir, "dir").oid },
      { mode: "160000", name: "vendored", oid: "1".repeat(40) },
    ]);
    gitCache.importObjects([{ type: "tree", payload: tree }]);
    let commitId = gitCache.writeCommitForTree(gitObjectOid("tree", tree), commit);
    // Legacy records whose paths name nothing, the directory and the submodule.
    let paths = new Map([
      ["55555555-5555-4555-8555-555555555555", "absent.bin"],
      ["66666666-6666-4666-8666-666666666666", "dir"],
      ["77777777-7777-4777-8777-777777777777", "vendored"],
    ]);
    for (let [fileId, workspacePath] of paths) {
      ws.impl.storage.chatAttachmentContent.put({
        fileId,
        state: { type: "committed", chatId: CHAT_ID, workspaceCommitId: commitId, workspacePath },
      });
      await expect(view.readChatAttachment(CHAT_ID, fileId))
          .rejects.toThrow("Chat attachment content is missing from Git.");
    }
    // A record that holds neither bytes, a blob nor a commit and a path.
    let bare = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    ws.impl.storage.chatAttachmentContent.put(
        { fileId: bare, state: { type: "committed", chatId: CHAT_ID } });
    await expect(view.readChatAttachment(CHAT_ID, bare))
        .rejects.toThrow("Chat attachment has no stored content.");

    let records = (await deploymentRecords(ws)).slice(1);
    expect(records.map(r => [r.method, r.args, r.exposed])).toStrictEqual(
        [...paths.keys(), bare].map(
            id => ["readChatAttachment", { chatId: CHAT_ID, id }, "metadata"]));
    for (let record of records) expect(record).not.toHaveProperty("refused");
  }));
});

describe("a chat's pending files", () => {
  it("are read as the chat holds them", () => withWorkspace(async ws => {
    allowContent(ws);
    putGrant(ws);
    let view = await openForContent(ws);
    // A modified and an added path hold the chat's text, and a removed one nothing.
    expect(await view.readPendingFile(DRAFT_CHAT_ID, ws.gadgetId, "notes.txt"))
        .toStrictEqual({ kind: "text", text: "draft notes\n" });
    expect(await view.readPendingFile(DRAFT_CHAT_ID, ws.gadgetId, "added.txt"))
        .toStrictEqual({ kind: "text", text: "added\n" });
    expect(await view.readPendingFile(DRAFT_CHAT_ID, ws.gadgetId, "todo.txt"))
        .toStrictEqual({ kind: "absent" });

    // A gadget the chat created, not accepted yet.
    let created = ws.impl.createGadget("Sketch", "SKETCH", DRAFT_CHAT_ID);
    await agentStep(ws, DRAFT_CHAT_ID,
        { [created.id]: [["main.js", { set: "code\n" }], ["lib/util.js", { set: "util\n" }]] });
    expect(await view.readPendingFile(DRAFT_CHAT_ID, created.id, "main.js"))
        .toStrictEqual({ kind: "text", text: "code\n" });
  }));

  it("stream a file the chat holds as bytes", () => withWorkspace(async ws => {
    allowContent(ws);
    putGrant(ws);
    let view = await openForContent(ws);
    let { id } = await addWorktreeChat(ws);
    let small = new Uint8Array([0x00, 0xff, 0x10, 0x80, 0x7f]);
    let large = patternBytes(LARGE_SIZE);
    let set = (content: Uint8Array) => ({ setBytes: ws.impl.gitCache.writeBlob(content) });
    await agentStep(ws, WORKTREE_CHAT_ID,
        { [id]: [["data.bin", set(small)], ["large.bin", set(large)]] });
    let noneWhole = watchWholeReads(ws);

    let file = await view.readPendingFile(WORKTREE_CHAT_ID, id, "data.bin");
    expect(file).toMatchObject({ kind: "stream", byteLength: small.byteLength });
    expect(await streamedBytes(file)).toStrictEqual(small);

    let streamed = await view.readPendingFile(WORKTREE_CHAT_ID, id, "large.bin");
    expect(streamed).toMatchObject({ kind: "stream", byteLength: LARGE_SIZE });
    let read = await streamedBytes(streamed);
    expect(read.byteLength === LARGE_SIZE && read.every((byte, i) => byte === large[i]))
        .toBe(true);
    noneWhole();
    // A path of the worktree the chat has not touched is not in its content.
    expect(await view.readPendingFile(WORKTREE_CHAT_ID, id, "src/untouched.txt"))
        .toStrictEqual({ kind: "absent" });

    expect((await deploymentRecords(ws)).slice(1).map(r => [r.method, r.args.path, r.exposed]))
        .toStrictEqual([
          ["readPendingFile", "data.bin", "content"], ["readPendingFile", "large.bin", "content"],
          ["readPendingFile", "src/untouched.txt", "metadata"],
        ]);
  }));

  it("send a text by the size of its UTF-8 encoding", () => withWorkspace(async ws => {
    allowContent(ws);
    putGrant(ws);
    let view = await openForContent(ws);
    // "é" is two bytes: the first text is exactly MAX_BUFFERED_BLOB_SIZE bytes in one character
    // fewer, and the second one byte over it in exactly that many characters.
    let atLimit = "é" + "a".repeat(MAX_BUFFERED_BLOB_SIZE - 2);
    let overLimit = `${atLimit}a`;
    expect(overLimit.length).toBe(MAX_BUFFERED_BLOB_SIZE);
    await submit(ws, DRAFT_CHAT_ID, { [ws.gadgetId]: [["at-limit.txt", { set: atLimit }]] });
    await submit(ws, DRAFT_CHAT_ID, { [ws.gadgetId]: [["over-limit.txt", { set: overLimit }]] });

    let whole = await view.readPendingFile(DRAFT_CHAT_ID, ws.gadgetId, "at-limit.txt");
    expect(whole.kind).toBe("text");
    expect(whole.kind === "text" && whole.text === atLimit).toBe(true);

    let streamed = await view.readPendingFile(DRAFT_CHAT_ID, ws.gadgetId, "over-limit.txt");
    expect(streamed).toMatchObject({ kind: "stream", byteLength: MAX_BUFFERED_BLOB_SIZE + 1 });
    let bytes = await streamedBytes(streamed);
    expect(bytes.byteLength).toBe(MAX_BUFFERED_BLOB_SIZE + 1);
    expect(new TextDecoder().decode(bytes) === overLimit).toBe(true);

    expect((await deploymentRecords(ws)).slice(1).map(r => [r.method, r.args.path, r.exposed]))
        .toStrictEqual([
          ["readPendingFile", "at-limit.txt", "content"],
          ["readPendingFile", "over-limit.txt", "content"],
        ]);
  }));
});

// What can overtake a call while it waits: the refusal it must then end in, and what brings it
// about. Each stops the call unrecorded.
const OVERTAKES: [string, string, (ws: Workspace) => Promise<void>][] = [
  ["the view expires", ADMIN_ACCESS_ERROR_CODES.viewExpired,
   async () => { await scheduler.wait(SHORT_LIFETIME_MS + 100); }],
  ["the admin is demoted", ADMIN_ACCESS_ERROR_CODES.notAdmin,
   async ws => {
     setEnv(ws, { ADMIN_WORKSPACE_ACCESS_MAX: "content", ADMINS: ["someone-else@example.test"] });
   }],
  ["the workspace is deleted", ADMIN_ACCESS_ERROR_CODES.workspaceNotFound,
   async ws => {
     await ws.state.storage.deleteAll();
     ws.impl.ownerId = undefined;
   }],
];

describe("a content read overtaken while the owner's account is asked for a grant", () => {
  describe.each<[string, () => unknown]>([
    ["a live account-wide grant", () => accountGrant()],
    ["none", () => null],
  ])("the account then answering with %s", (_answer, answer) => {
    it.each(OVERTAKES)("writes nothing and reads nothing when %s", (_case, code, overtake) =>
        withWorkspace(async ws => {
      allowContent(ws);
      // The workspace holds no grant of its own, so each call asks the owner's account, which
      // holds its answer until the test lets it go.
      let release!: () => void;
      let released = new Promise<void>(resolve => { release = resolve; });
      ws.account.answer = async () => {
        await released;
        return answer();
      };
      let expires = code === ADMIN_ACCESS_ERROR_CODES.viewExpired;
      let view = await openForContent(ws,
          expires ? { expiresAt: new Date(Date.now() + SHORT_LIFETIME_MS) } : {});
      let reads = watchReads(ws);

      let calls = CONTENT_METHODS.map(method => codeOf(contentReads(ws, view)[method]()));
      while (ws.account.asked.length < CONTENT_METHODS.length) await settled();
      await overtake(ws);
      release();

      // Neither the refusal for want of a grant nor an attempt: the view's own check comes
      // first, and stops each call before it records or reads anything.
      expect(await Promise.all(calls)).toStrictEqual(CONTENT_METHODS.map(() => code));
      for (let read of reads) expect(read).not.toHaveBeenCalled();
      expect((await deploymentRecords(ws)).map(r => r.method))
          .toStrictEqual(["inspectWorkspace"]);
      expect(ws.account.asked).toHaveLength(CONTENT_METHODS.length);
      if (code === ADMIN_ACCESS_ERROR_CODES.workspaceNotFound) {
        expect(storageKeys(ws)).toStrictEqual([]);
      }
    }));
  });
});

describe("a view method of each kind, with no grant", () => {
  it("answers, answers withheld, or is refused, as its kind says", () => withWorkspace(async ws => {
    allowContent(ws);
    let view = await openForContent(ws);

    // Metadata alone: answered, the owner's account never asked for a grant.
    expect(ADMIN_METHOD_ANSWERS.listFiles).toBe("metadata");
    expect((await view.listFiles(ws.gadgetId)).map(node => node.name))
        .toStrictEqual(["notes.txt", "todo.txt"]);
    expect(ws.account.asked).toStrictEqual([]);

    // Mixed: answered as the "metadata" level answers.
    expect(ADMIN_METHOD_ANSWERS.listChats).toBe("mixed");
    expect(await seededChat(view)).not.toHaveProperty("queuedSteers");
    expect(ws.account.asked).toHaveLength(1);

    // Content alone: refused.
    expect(ADMIN_METHOD_ANSWERS.getChat).toBe("content");
    expect(await codeOf(view.getChat(CHAT_ID))).toBe(ADMIN_ACCESS_ERROR_CODES.grantRequired);
    expect(ws.account.asked).toHaveLength(2);

    expect((await deploymentRecords(ws)).slice(1).map(r => [r.method, r.exposed, r.refused]))
        .toStrictEqual([
          ["listFiles", "metadata", undefined], ["listChats", "metadata", undefined],
          ["getChat", "metadata", ADMIN_ACCESS_ERROR_CODES.grantRequired],
        ]);
  }));
});
