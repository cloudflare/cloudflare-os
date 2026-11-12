import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import type { ActionDescription, ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRIVE_ACTIONS, type DriveAction, type DriveActions } from "../src/drive-actions";
import type { DriveEditorsHost } from "../src/drive-editors";
import {
  DriveApiRequestError, FOLDER_MIME_TYPE, type DriveApi, type DriveCommentRecord,
  type DrivePermissionRecord, type DriveScopeNode,
} from "../src/drive-api";
import type { DriveWritesHost, WriteAttempt } from "../src/drive-writes";
import type { SlidesActions } from "../src/slides-simulation";
import { FakeKv } from "./fake-kv";

const COMMENTS: ActionKind = { tag: "driveComments", label: "Drive comments" };
const SHARING: ActionKind = { tag: "driveSharing", label: "Drive sharing" };
const MOVES: ActionKind = { tag: "driveMoves", label: "Drive moves" };

/** The writes of the Drive API itself, apart from the edits of native files. */
type DriveWrite = Exclude<keyof DriveActions, keyof SlidesActions>;

/** What each definition declares, by the name its records are stored under. */
const DECLARED: Record<DriveWrite, { actionKind: ActionKind; autoApprovable: boolean }> = {
  createComment: { actionKind: COMMENTS, autoApprovable: true },
  createReply: { actionKind: COMMENTS, autoApprovable: true },
  resolveComment: { actionKind: COMMENTS, autoApprovable: true },
  suggestEdit: { actionKind: COMMENTS, autoApprovable: true },
  createPermission: { actionKind: SHARING, autoApprovable: false },
  updatePermission: { actionKind: SHARING, autoApprovable: false },
  deletePermission: { actionKind: SHARING, autoApprovable: false },
  moveFile: { actionKind: MOVES, autoApprovable: false },
};

/** The names the eight definitions' records are stored under. */
const NAMES = [
  "createComment", "createReply", "resolveComment", "suggestEdit", "createPermission",
  "updatePermission",
  "deletePermission", "moveFile",
] as const satisfies readonly DriveWrite[];

/** The kinds made as one Google account, which are staged and applied under a fence. */
const FENCED: ReadonlySet<keyof DriveActions> =
  new Set(["createPermission", "updatePermission", "deletePermission", "moveFile"]);

const REPLACED =
  "This action was approved under a connection that has since been replaced. Reject it and " +
  "submit it again.";

const OWNER_ID = "11111111111111111111";
const BOB_ID = "22222222222222222222";
const CAROL_ID = "33333333333333333333";
const ZOE_ID = "44444444444444444444";

const TARGET = { fileId: "F", fileName: "Plan.pdf" };
const QUEUED = { fileId: "F", queuedAt: "2026-10-20T10:00:00.000Z" };
const PARENT = {
  author: "Ada Lovelace", excerpt: "Is this date right?",
  // SHA-256 of the excerpt, which is the whole comment.
  sha256: "6037d22871e6e0fd5e8ea393fe71f57d38f12391d7e5f6507097e05108177f6c",
};

const COMMENT: DriveActions["createComment"] = { ...QUEUED, content: "Looks good." };
const SUGGESTION: DriveActions["suggestEdit"] =
  { ...QUEUED, tabId: "t.0", oldText: "May", newText: "June" };
const REPLY: DriveActions["createReply"] =
  { ...QUEUED, commentId: "doco.c1", content: "Yes.", parent: PARENT };
const RESOLVE: DriveActions["resolveComment"] = { ...QUEUED, commentId: "doco.c1", parent: PARENT };
const SHARE: DriveActions["createPermission"] = {
  ...TARGET, grantee: { type: "user", emailAddress: "zoe@example.com" }, role: "reader",
};
const RAISE: DriveActions["updatePermission"] = {
  ...TARGET, permissionId: BOB_ID,
  grantee: { type: "user", emailAddress: "bob@example.com", displayName: "Bob Example" },
  fromRole: "reader", toRole: "writer",
};
const REMOVAL: DriveActions["deletePermission"] = {
  ...TARGET, permissionId: CAROL_ID,
  grantee: { type: "user", emailAddress: "carol@example.com", displayName: "Carol Example" },
  role: "commenter",
};
const MOVE: DriveActions["moveFile"] =
  { ...TARGET, fromFolderId: "A", toFolderId: "B", toName: "Archive" };

/** A person's permission given on the file itself, as Drive lists one. */
function person(
  id: string, name: string, role: DrivePermissionRecord["role"],
): DrivePermissionRecord {
  return {
    id, type: "user", role, emailAddress: `${name.toLowerCase()}@example.com`,
    displayName: `${name} Example`, deleted: false, details: [{ role, inherited: false }],
  };
}

/** A live folder the account can list and add to, as a scope proof reads it. */
function folder(id: string): DriveScopeNode {
  return {
    id, mimeType: FOLDER_MIME_TYPE, parents: ["R"], trashed: false, canListChildren: true,
    canAddChildren: true,
  };
}

/** A Drive call no case here makes. */
const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected call");
};

beforeEach(() => {
  // A write that is made is logged, which no case here reads.
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The Docs API, through which no sharing change or move is sent. */
const NO_DOCS: DriveWritesHost["docs"] = {
  getDocumentWithSuggestions: async () => { throw new Error("Unexpected call"); },
  getRevisionId: async () => { throw new Error("Unexpected call"); },
  insertComment: async () => { throw new Error("Unexpected call"); },
  suggest: async () => { throw new Error("Unexpected call"); },
  replyToSuggestion: async () => { throw new Error("Unexpected call"); },
};

/**
 * The Drive set bound over an in-memory journal, as an all-of-Drive binding's gatekeeper binds it.
 * Its Drive holds file `F` in folder `A`, beside folder `B`, shared with Bob and Carol, and
 * answers the writes a case sends: a comment, a share, a role change, a removal and a move.
 */
function harness() {
  let nodes: Record<string, DriveScopeNode> = {
    A: folder("A"), B: folder("B"),
    F: {
      id: "F", mimeType: "application/pdf", parents: ["A"], trashed: false, canComment: true,
      canShare: true, canMoveItemWithinDrive: true,
    },
  };
  let permissions = [
    person(OWNER_ID, "Me", "owner"), person(BOB_ID, "Bob", "reader"),
    person(CAROL_ID, "Carol", "commenter"),
  ];
  /** The permission of `F` with ID `permissionId`, or Drive's answer for one that is not there. */
  let held = (permissionId: string): DrivePermissionRecord => {
    let listed = permissions.find(permission => permission.id === permissionId);
    if (!listed) throw new DriveApiRequestError(404, "notFound");
    return listed;
  };
  let posted: DriveCommentRecord = {
    id: "doco.posted", content: COMMENT.content, author: { displayName: "Me", me: true },
    createdTime: "2026-10-20T10:00:01.000Z", resolved: false, deleted: false, replies: [],
  };
  let api = {
    getScopeNodes: vi.fn<DriveApi["getScopeNodes"]>(
      async ids => ids.map(id => nodes[id] && structuredClone(nodes[id]))),
    getComment: vi.fn<DriveApi["getComment"]>(unexpected),
    listComments: vi.fn<DriveApi["listComments"]>(unexpected),
    listReplies: vi.fn<DriveApi["listReplies"]>(unexpected),
    createComment: vi.fn<DriveApi["createComment"]>(async () => posted),
    createReply: vi.fn<DriveApi["createReply"]>(unexpected),
    listPermissions: vi.fn<DriveApi["listPermissions"]>(
      async () => ({ permissions: structuredClone(permissions) })),
    createPermission: vi.fn<DriveApi["createPermission"]>(async (_fileId, grant) => {
      let made = person(ZOE_ID, "Zoe", grant.role);
      permissions.push(made);
      return structuredClone(made);
    }),
    updatePermission: vi.fn<DriveApi["updatePermission"]>(async (_fileId, permissionId, role) => {
      let listed = held(permissionId);
      listed.role = role;
      listed.details = [{ role, inherited: false }];
      return structuredClone(listed);
    }),
    deletePermission: vi.fn<DriveApi["deletePermission"]>(async (_fileId, permissionId) => {
      permissions.splice(permissions.indexOf(held(permissionId)), 1);
    }),
    swapParent: vi.fn<DriveApi["swapParent"]>(async (fileId, { addParent }) => {
      nodes[fileId] = { ...nodes[fileId], parents: [addParent] };
      return { id: fileId, parents: [addParent] };
    }),
  };
  let attempts = new Map<number, WriteAttempt>();
  let host: DriveWritesHost & DriveEditorsHost = {
    api,
    docs: NO_DOCS,
    editors: {
      slides: () => { throw new Error("No Slides edit is applied here."); },
    },
    scope: () => ({ kind: "account" }),
    writeRefusal: async () => undefined,
    attempts: {
      get: id => attempts.get(id),
      put: (id, attempt) => { attempts.set(id, attempt); },
      delete: id => { attempts.delete(id); },
    },
  };
  let journal = new ActionJournal<DriveAction>(new FakeKv(), { namespace: "drive" });
  let actions = DRIVE_ACTIONS.bind(journal, host);
  let described = new Map<number, ActionDescription>();
  let queue = {
    submitAction: async (id: number, description: ActionDescription) => {
      described.set(id, description);
    },
  };
  return {
    api, journal, actions, queue, described,
    /**
     * Queues one write as the gatekeeper does: under the account `generation` names for a fenced
     * kind, and under nothing for a comment.
     */
    submit: <K extends keyof DriveActions>(
      kind: K, payload: DriveActions[K], generation = "A",
    ): Promise<number> =>
      actions.submit(queue, kind, payload, FENCED.has(kind) ? { fence: { generation } } : {}),
    /** How many requests have been made of Drive, of any kind. */
    requests: () => Object.values(api).reduce((sum, call) => sum + call.mock.calls.length, 0),
    /** How many requests that change something have been made of Drive. */
    sends: () => api.createComment.mock.calls.length + api.createReply.mock.calls.length +
      api.createPermission.mock.calls.length + api.updatePermission.mock.calls.length +
      api.deletePermission.mock.calls.length + api.swapParent.mock.calls.length,
    /** Where the file is and who it is shared with, as Drive holds them now. */
    drive: () => ({
      parents: nodes.F.parents,
      access: permissions.map(({ emailAddress, role }) => [emailAddress, role]),
    }),
  };
}

describe("Drive actions", () => {
  it("declares the eight Drive writes under three kinds, none of which can be reverted", async () => {
    let { actions, journal, described, submit } = harness();
    let ids: Record<DriveWrite, number> = {
      createComment: await submit("createComment", COMMENT),
      createReply: await submit("createReply", REPLY),
      resolveComment: await submit("resolveComment", RESOLVE),
      suggestEdit: await submit("suggestEdit", SUGGESTION),
      createPermission: await submit("createPermission", SHARE),
      updatePermission: await submit("updatePermission", RAISE),
      deletePermission: await submit("deletePermission", REMOVAL),
      moveFile: await submit("moveFile", MOVE),
    };
    // A queued write resolves its definition by the name its record is stored under.
    expect(journal.listUndecided().map(entry => entry.action.kind)).toEqual(NAMES);
    expect(Object.keys(DECLARED)).toEqual(NAMES);

    for (let name of NAMES) {
      let card = described.get(ids[name]);
      expect(card, name).toMatchObject({ ...DECLARED[name], implementsRevert: false });
      // Only a move waits for its decision: every other write is shown as if made.
      if (name === "moveFile") expect(card, name).toHaveProperty("awaitDecision", true);
      else expect(card, name).not.toHaveProperty("awaitDecision");
    }

    // Then the kinds of the native files' edits (drive-editors.test.ts).
    expect(actions.autoApprovableKinds()[0]).toEqual(COMMENTS);
    expect(actions.autoApprovableKinds()).not.toContainEqual(SHARING);
    expect(actions.autoApprovableKinds()).not.toContainEqual(MOVES);
    expect(actions.retainsApplied).toBe(false);
  });

  it("numbers every kind from one journal", async () => {
    let { journal, submit } = harness();
    expect(await submit("createComment", COMMENT)).toBe(1);
    expect(await submit("createPermission", SHARE)).toBe(2);
    expect(await submit("moveFile", MOVE)).toBe(3);
    expect(journal.listUndecided()).toEqual([
      { id: 1, action: { kind: "createComment", payload: COMMENT } },
      { id: 2, action: { kind: "createPermission", payload: SHARE } },
      { id: 3, action: { kind: "moveFile", payload: MOVE } },
    ]);
  });

  it("fences sharing and moves on the account, and comments on nothing", async () => {
    let { api, actions, journal, queue, described, submit, requests } = harness();

    // A write made as one Google account cannot be queued without naming it.
    for (let unfenced of [
      () => actions.submit(queue, "createPermission", SHARE),
      () => actions.submit(queue, "updatePermission", RAISE),
      () => actions.submit(queue, "deletePermission", REMOVAL),
      () => actions.submit(queue, "moveFile", MOVE),
    ]) {
      await expect(unfenced()).rejects.toThrow(/authority-fenced/);
    }
    // A comment posts as whichever account is connected, and cannot be pinned to one.
    let fence = { generation: "A" };
    for (let fenced of [
      () => actions.submit(queue, "createComment", COMMENT, { fence }),
      () => actions.submit(queue, "createReply", REPLY, { fence }),
      () => actions.submit(queue, "resolveComment", RESOLVE, { fence }),
    ]) {
      await expect(fenced()).rejects.toThrow(/authority-independent/);
    }
    expect(journal.listUndecided()).toEqual([]);
    expect(described.size).toBe(0);

    // Staged as account A and approved while account B is connected.
    let replaced = await submit("createPermission", SHARE, "A");
    expect(journal.get(replaced)).toMatchObject({ fence: { generation: "A" } });
    await expect(actions.apply(replaced, { generation: "B" })).rejects.toThrow(REPLACED);
    expect(requests()).toBe(0);
    expect(journal.get(replaced)).toMatchObject({ state: "failed", error: REPLACED });
    // A failed record answers with what it stored, whichever account is connected by then.
    await expect(actions.apply(replaced, { generation: "A" })).rejects.toThrow(REPLACED);
    expect(requests()).toBe(0);

    let kept = await submit("createPermission", SHARE, "A");
    await expect(actions.apply(kept, { generation: "A" })).resolves.toBeUndefined();
    expect(api.createPermission).toHaveBeenCalledTimes(1);
    expect(journal.get(kept)).toBeUndefined();

    // A comment carries no fence, and applies with no account named.
    let comment = await submit("createComment", COMMENT);
    expect(journal.get(comment)).not.toHaveProperty("fence");
    await expect(actions.apply(comment)).resolves.toBeUndefined();
    expect(api.createComment).toHaveBeenCalledTimes(1);
  });

  it("keeps nothing of what it applied", async () => {
    let { api, actions, journal, submit, requests, sends, drive } = harness();
    let generation = "A";
    let share = await submit("createPermission", SHARE);
    let raise = await submit("updatePermission", RAISE);
    let removal = await submit("deletePermission", REMOVAL);
    let move = await submit("moveFile", MOVE);
    let comment = await submit("createComment", COMMENT);
    let fenced = [share, raise, removal, move];

    for (let id of fenced) {
      await expect(actions.apply(id, { generation })).resolves.toBeUndefined();
    }
    await expect(actions.apply(comment)).resolves.toBeUndefined();
    expect(api.createPermission).toHaveBeenCalledTimes(1);
    expect(api.updatePermission.mock.calls).toEqual([["F", BOB_ID, "writer"]]);
    expect(api.deletePermission.mock.calls).toEqual([["F", CAROL_ID]]);
    expect(api.swapParent.mock.calls).toEqual([["F", { addParent: "B", removeParent: "A" }]]);
    expect(api.createComment.mock.calls).toEqual([["F", COMMENT.content]]);
    expect(sends()).toBe(5);
    let changed = {
      parents: ["B"],
      access: [
        ["me@example.com", "owner"], ["bob@example.com", "writer"], ["zoe@example.com", "reader"],
      ],
    };
    expect(drive()).toEqual(changed);

    // Each record is retired as its apply returns, and no retained tier holds a copy of one.
    for (let id of [...fenced, comment]) expect(journal.get(id)).toBeUndefined();
    expect(journal.listUndecided()).toEqual([]);
    expect(journal.listRetained({ limit: 10 }).entries).toEqual([]);

    // An approval repeated for an applied action is answered without asking Drive anything.
    let asked = requests();
    for (let id of fenced) {
      await expect(actions.apply(id, { generation })).resolves.toBeUndefined();
    }
    await expect(actions.apply(comment)).resolves.toBeUndefined();
    expect(requests()).toBe(asked);
    expect(drive()).toEqual(changed);

    // What was applied is not undone by rejecting it.
    for (let id of [...fenced, comment]) {
      await expect(actions.reject(id)).rejects.toThrow(`Action ${id} is no longer pending.`);
    }
    expect(requests()).toBe(asked);
    expect(drive()).toEqual(changed);
  });
});
