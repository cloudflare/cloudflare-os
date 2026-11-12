import { ActionJournal, defineActions } from "@gadgets/gatekeeper-kit/actions";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DriveApiDisabledError, DriveApiRequestError, FOLDER_MIME_TYPE, type DriveApi,
  type DriveScopeNode,
} from "../src/drive-api";
import {
  DRIVE_MOVE_DEFINITIONS, DRIVE_MOVES, hasPendingMove, MOVE_DESTINATION_WAITING, MOVE_PENDING,
  MOVE_WAITING, proveMove, type DriveMoveAction, type DriveMoveActions,
} from "../src/drive-moves";
import type { DriveBindingScope } from "../src/drive-session";
import {
  CREDENTIALS_NOT_ACCEPTED, readOnlyRefusal, WRITES_GRANT_MISSING, type DriveWritesHost,
  type QueuedWrite, type WriteAttempt,
} from "../src/drive-writes";
import { FakeKv } from "./fake-kv";

const KIND = { tag: "driveMoves", label: "Drive moves" };
const ACCOUNT: DriveBindingScope = { kind: "account" };
const AT_R: DriveBindingScope = { kind: "folder", folderId: "R" };

const OUT_OF_SCOPE = "That file is no longer in this connection's scope.";
const ALREADY_MOVED =
  "That file was already moved there after this was queued, so nothing was changed.";
const NOT_WHERE_IT_WAS =
  "That file is no longer in the folder it was to be moved from, so it was not moved.";
const FILE_IN_TRASH = "That file is in the trash, so it was not moved.";
const DESTINATION_IN_TRASH = "That folder is in the trash, so nothing was moved into it.";
const CANNOT_MOVE = "The connected account can no longer move that file there.";
const UNCONFIRMED_MOVE =
  "Google Drive did not confirm whether this was moved, and it may have been. Approving it " +
  "again first checks where the file is, so it is not moved twice; rejecting it leaves the file " +
  "wherever it is.";
const MOVED_AGAIN =
  "This file was moved again on Google Drive after this was first sent, so it was left where it " +
  "is. Check where it is, then reject this to clear it.";
const NO_LONGER_SHOWN =
  "Google Drive no longer shows this file to the connected account where this connection " +
  "reaches it, so whether it was moved can't be checked, and it won't be moved again. Reject it " +
  "to clear it.";
const RATE_LIMITED =
  "Google Drive is limiting requests from this account. Approve it again in a minute.";

const OPENING =
  "**Moving changes who has access.** Move Google Drive file `F` from folder `A` into folder " +
  "`B`, as the connected account.";
const WITH_IT = "Everything in it moves with it.";
const LEAVES_MY_DRIVE =
  "The folder it leaves is the top level of the connected account's My Drive.";
const ENTERS_MY_DRIVE =
  "The folder it goes into is the top level of the connected account's My Drive.";
const TAKES_SHARING =
  "It takes the sharing of the folder it goes into: everyone with access to that folder gains " +
  "access to it, and access it had only through the folder it leaves is lost. Access given on " +
  "it directly that the new folder also gives is merged into the folder's, and does not come " +
  "back if it is moved out again.";

/** A live folder the account can list, add to and move, as a scope proof reads it. */
function folder(id: string, parent: string): DriveScopeNode {
  return {
    id, mimeType: FOLDER_MIME_TYPE, parents: [parent], trashed: false, canListChildren: true,
    canAddChildren: true, canMoveItemWithinDrive: true,
  };
}

/** A live file the account can move, as a scope proof reads it. */
function file(id: string, parent: string): DriveScopeNode {
  return {
    id, mimeType: "application/pdf", parents: [parent], trashed: false,
    canMoveItemWithinDrive: true,
  };
}

/** Folder `R` holds folder `A`, which holds folder `B` and file `F`; a test may add to it. */
type Tree = Record<"R" | "A" | "B" | "F", DriveScopeNode> &
  Record<string, DriveScopeNode | undefined>;

function tree(): Tree {
  return { R: folder("R", "above"), A: folder("A", "R"), B: folder("B", "A"), F: file("F", "A") };
}

/** A move of `F` out of `A` into its child folder `B`, as an account binding queues it. */
function intoB(
  overrides: Partial<DriveMoveActions["moveFile"]> = {},
): DriveMoveActions["moveFile"] {
  return {
    fileId: "F", fileName: "Budget 2026", fromFolderId: "A", toFolderId: "B", toName: "Archive",
    ...overrides,
  };
}

/** The same move as a folder binding at `R` queues it from the session opened at `A`. */
function intoBFromA(
  overrides: Partial<DriveMoveActions["moveFile"]> = {},
): DriveMoveActions["moveFile"] {
  return intoB({ fromName: "Finance", folderIds: ["R", "A"], ...overrides });
}

/** A move of `F` up out of `A` into `R`, the folder the session at `A` was opened from. */
function upToR(): DriveMoveActions["moveFile"] {
  return { fileId: "F", fromFolderId: "A", toFolderId: "R", folderIds: ["R", "A"] };
}

/**
 * The record of a move that failed for good with nothing sent: it carries no outcome, which is how
 * a failure known to have changed nothing is stored.
 */
function failedUnsent(payload: DriveMoveActions["moveFile"], error: string) {
  return { state: "failed", action: { kind: "moveFile", payload }, error };
}

/** Drive's answer to a send whose outcome it leaves open. */
const unconfirmed = () => new DriveApiRequestError(503, "backendError");
/** Drive's refusal of a token that lacks the scope a request needs. */
const missingScope = () => new DriveApiRequestError(403, "insufficientPermissions");

afterEach(() => {
  vi.restoreAllMocks();
});

/** The move definitions as a set of their own; the gatekeeper binds them among the others. */
const MOVE_ACTIONS = defineActions<DriveWritesHost, DriveMoveActions>(
  DRIVE_MOVE_DEFINITIONS, { fence: "none", vendorId: "google" });

/** A Drive call no move makes. */
const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected call");
};

/** The Docs API, through which no sharing change or move is sent. */
const NO_DOCS: DriveWritesHost["docs"] = {
  getDocumentWithSuggestions: async () => { throw new Error("Unexpected call"); },
  getRevisionId: async () => { throw new Error("Unexpected call"); },
  insertComment: async () => { throw new Error("Unexpected call"); },
  suggest: async () => { throw new Error("Unexpected call"); },
  replyToSuggestion: async () => { throw new Error("Unexpected call"); },
};

/**
 * The move set bound over an in-memory journal, with a host whose batch read answers from a tree
 * a test can change and whose move rewrites it.
 */
function harness(scope: DriveBindingScope = ACCOUNT) {
  let nodes = tree();
  let hidden = new Set<string>();
  let attempts = new Map<number, WriteAttempt>();
  let refused: string | undefined;
  let described: ActionDescription | undefined;
  /** What Drive does with a move: one parent swapped for another. */
  let relocate: DriveApi["swapParent"] = async (fileId, { addParent, removeParent }) => {
    let node = nodes[fileId];
    if (!node) throw new DriveApiRequestError(404, "notFound");
    let parents = [...(node.parents ?? []).filter(parent => parent !== removeParent), addParent];
    nodes[fileId] = { ...node, parents };
    return { id: fileId, parents };
  };
  let api = {
    getScopeNodes: vi.fn<DriveApi["getScopeNodes"]>(async ids => ids.map(id => {
      let node = nodes[id];
      return node && !hidden.has(id) ? structuredClone(node) : undefined;
    })),
    getComment: vi.fn<DriveApi["getComment"]>(unexpected),
    listComments: vi.fn<DriveApi["listComments"]>(unexpected),
    listReplies: vi.fn<DriveApi["listReplies"]>(unexpected),
    createComment: vi.fn<DriveApi["createComment"]>(unexpected),
    createReply: vi.fn<DriveApi["createReply"]>(unexpected),
    listPermissions: vi.fn<DriveApi["listPermissions"]>(unexpected),
    createPermission: vi.fn<DriveApi["createPermission"]>(unexpected),
    updatePermission: vi.fn<DriveApi["updatePermission"]>(unexpected),
    deletePermission: vi.fn<DriveApi["deletePermission"]>(unexpected),
    swapParent: vi.fn<DriveApi["swapParent"]>(relocate),
  };
  let host: DriveWritesHost = {
    api,
    docs: NO_DOCS,
    scope: () => scope,
    writeRefusal: async () => refused,
    attempts: {
      get: id => attempts.get(id),
      put: (id, attempt) => { attempts.set(id, attempt); },
      delete: id => { attempts.delete(id); },
    },
  };
  let journal = new ActionJournal<DriveMoveAction>(new FakeKv(), { namespace: "drive" });
  let actions = MOVE_ACTIONS.bind(journal, host);
  let queue = {
    submitAction: async (_id: number, description: ActionDescription) => { described = description; },
  };
  let submit = (payload: DriveMoveActions["moveFile"]) => actions.submit(queue, "moveFile", payload);
  return {
    api, host, journal, actions, attempts, nodes, submit, relocate,
    /** Submits one move and returns what its approval shows. */
    async card(payload: DriveMoveActions["moveFile"]): Promise<ActionDescription> {
      await submit(payload);
      if (!described) throw new Error("nothing was described");
      return described;
    },
    /** Applies an action, answering `null` when it applied and the failure's message otherwise. */
    apply: (id: number): Promise<string | null> =>
      actions.apply(id).then(() => null, (error: Error) => error.message),
    /** Sets what the binding's write refusal answers from here on. */
    refuse(message: string | undefined): void { refused = message; },
    /** Makes Drive stop showing `ids` to the account, or show all of the tree again. */
    hide(...ids: string[]): void {
      hidden.clear();
      for (let id of ids) hidden.add(id);
    },
    /** Makes the next send move the file and then answer `error`. */
    moveThenAnswer(error: Error): void {
      api.swapParent.mockImplementationOnce(async (...args) => {
        await relocate(...args);
        throw error;
      });
    },
  };
}

describe("Drive move verdict and approval card", () => {
  it("declares a kind that is never auto-approvable, awaits its decision and says it cannot be reverted", async () => {
    let { actions, card } = harness();
    expect(DRIVE_MOVES).toEqual(KIND);
    expect(await card(intoB())).toMatchObject({
      autoApprovable: false, actionKind: KIND, awaitDecision: true, implementsRevert: false,
    });
    expect(actions.autoApprovableKinds()).toEqual([]);
  });

  it("says first that moving changes who has access, then the file and both folders", async () => {
    let fromFolder = await harness(AT_R).card(intoBFromA());
    expect(fromFolder.title).toBe("Move a Google Drive file");
    expect(fromFolder.description).toBe(`${OPENING}\n\n${TAKES_SHARING}`);
    expect(fromFolder.fields).toEqual([
      { label: "File", kind: "inline", value: "F" },
      { label: "File name", kind: "inline", value: "Budget 2026" },
      { label: "From folder", kind: "inline", value: "A" },
      { label: "From folder name", kind: "inline", value: "Finance" },
      { label: "To folder", kind: "inline", value: "B" },
      { label: "To folder name", kind: "inline", value: "Archive" },
    ]);
    expect(fromFolder.descriptionIsComplete).toBe(true);

    // An account binding does not show the name of the folder a file leaves.
    let fromAccount = await harness().card(intoB());
    expect(fromAccount.description).toBe(`${OPENING}\n\n${TAKES_SHARING}`);
    expect(fromAccount.fields).toEqual([
      { label: "File", kind: "inline", value: "F" },
      { label: "File name", kind: "inline", value: "Budget 2026" },
      { label: "From folder", kind: "inline", value: "A" },
      { label: "To folder", kind: "inline", value: "B" },
      { label: "To folder name", kind: "inline", value: "Archive" },
    ]);

    let aFolder = await harness().card(intoB({ isFolder: true }));
    expect(aFolder.title).toBe("Move a Google Drive folder");
    expect(aFolder.description).toBe(
      "**Moving changes who has access.** Move Google Drive folder `F` from folder `A` into " +
      `folder \`B\`, as the connected account.\n\n${WITH_IT}\n\n${TAKES_SHARING}`);
    expect(fromAccount.description).not.toContain(WITH_IT);
  });

  it("names the top level of the account's own My Drive in its own words", async () => {
    let leaving = await harness().card(intoB({ fromMyDrive: true }));
    expect(leaving.description).toBe(`${OPENING}\n\n${LEAVES_MY_DRIVE}\n\n${TAKES_SHARING}`);
    expect(leaving.fields?.map(field => field.label))
      .toEqual(["File", "File name", "From folder", "To folder", "To folder name"]);

    let { toName: _toName, ...unnamed } = intoB({ toMyDrive: true });
    let entering = await harness().card(unnamed);
    expect(entering.description).toBe(`${OPENING}\n\n${ENTERS_MY_DRIVE}\n\n${TAKES_SHARING}`);
    expect(entering.fields).toEqual([
      { label: "File", kind: "inline", value: "F" },
      { label: "File name", kind: "inline", value: "Budget 2026" },
      { label: "From folder", kind: "inline", value: "A" },
      { label: "To folder", kind: "inline", value: "B" },
    ]);

    // A folder moved to the top level: each sentence is a paragraph of its own.
    let folderToTop = await harness().card({ ...unnamed, isFolder: true });
    expect(folderToTop.description.split("\n\n")).toEqual([
      OPENING.replace("file `F`", "folder `F`"), WITH_IT, ENTERS_MY_DRIVE, TAKES_SHARING,
    ]);
  });

  it("keeps names in fields, whatever they hold", async () => {
    let fileName = "Plan\n# Approved";
    let fromName = "**Approved** by your administrator";
    let toName = "[Archive](https://example.com/x) <img src=x>";
    let description = await harness(AT_R).card(intoBFromA({ fileName, fromName, toName }));
    expect(description.description).toBe(`${OPENING}\n\n${TAKES_SHARING}`);
    expect(description.title).toBe("Move a Google Drive file");
    expect(description.fields).toEqual([
      { label: "File", kind: "inline", value: "F" },
      // A name one line cannot show exactly is shown as text, whole.
      { label: "File name", kind: "text", value: fileName },
      { label: "From folder", kind: "inline", value: "A" },
      { label: "From folder name", kind: "inline", value: fromName },
      { label: "To folder", kind: "inline", value: "B" },
      { label: "To folder name", kind: "inline", value: toName },
    ]);
    expect(description.descriptionIsComplete).toBe(true);

    // A move queued without names shows the IDs alone.
    let bare = await harness().card({ fileId: "F", fromFolderId: "A", toFolderId: "B" });
    expect(bare.fields?.map(field => field.label)).toEqual(["File", "From folder", "To folder"]);
  });
});

describe("Drive move proofs at apply", () => {
  it("proves a move for each binding", async () => {
    // An account binding: where the file is, among folders the account can see.
    let account = harness();
    let { F, A, B } = account.nodes;
    expect(await proveMove(account.host, intoB()))
      .toEqual({ at: "source", file: F, source: A, destination: B });
    expect(account.api.getScopeNodes).toHaveBeenCalledTimes(1);
    expect(account.api.getScopeNodes).toHaveBeenCalledWith(["F", "A", "B"]);

    let moved = harness();
    moved.nodes.F = file("F", "B");
    expect(await proveMove(moved.host, intoB()))
      .toEqual({ at: "destination", file: moved.nodes.F, source: A, destination: B });
    expect(moved.api.getScopeNodes).toHaveBeenCalledTimes(1);

    let elsewhere: [string, DriveScopeNode][] = [
      ["a third folder", file("F", "C")],
      ["two parents", { ...file("F", "A"), parents: ["A", "B"] }],
      ["no parent", { id: "F", mimeType: "application/pdf", trashed: false }],
    ];
    for (let [what, node] of elsewhere) {
      let { host, nodes, api } = harness();
      nodes.F = node;
      expect(await proveMove(host, intoB()), what).toEqual({ at: "elsewhere" });
      expect(api.getScopeNodes, what).toHaveBeenCalledTimes(1);
    }

    for (let invisible of ["F", "A", "B"]) {
      let { host, hide, api } = harness();
      hide(invisible);
      expect(await proveMove(host, intoB()), invisible).toBeUndefined();
      expect(api.getScopeNodes, invisible).toHaveBeenCalledTimes(1);
    }

    // Where the file is, and nothing else: what a send needs beyond that is its caller's to ask.
    let leftToCaller: [string, "F" | "A" | "B", Partial<DriveScopeNode>][] = [
      ["the file in the trash", "F", { trashed: true }],
      ["the source in the trash", "A", { trashed: true }],
      ["the destination in the trash", "B", { trashed: true }],
      ["the destination a Doc", "B", { mimeType: "application/vnd.google-apps.document" }],
      ["the destination in another drive", "B", { driveId: "team" }],
    ];
    for (let [what, id, change] of leftToCaller) {
      let { host, nodes } = harness();
      nodes[id] = { ...nodes[id], ...change };
      expect(await proveMove(host, intoB()), what).toEqual({
        at: "source", file: nodes.F, source: nodes.A, destination: nodes.B,
      });
    }

    // A single-file binding has no move, and nothing is read for one.
    let single = harness({ kind: "file", fileId: "F" });
    expect(await proveMove(single.host, intoB())).toBeUndefined();
    expect(single.api.getScopeNodes).not.toHaveBeenCalled();
  });

  it("proves a folder binding's move down into a child folder and up to the folder it was opened from", async () => {
    let down = harness(AT_R);
    let { R, A, B, F } = down.nodes;
    expect(await proveMove(down.host, intoBFromA()))
      .toEqual({ at: "source", file: F, source: A, destination: B });
    expect(down.api.getScopeNodes).toHaveBeenCalledTimes(1);
    expect(down.api.getScopeNodes).toHaveBeenCalledWith(["R", "A", "F", "B"]);
    down.nodes.F = file("F", "B");
    expect(await proveMove(down.host, intoBFromA()))
      .toEqual({ at: "destination", file: down.nodes.F, source: A, destination: B });

    let up = harness(AT_R);
    expect(await proveMove(up.host, upToR()))
      .toEqual({ at: "source", file: F, source: A, destination: R });
    expect(up.api.getScopeNodes).toHaveBeenCalledTimes(1);
    expect(up.api.getScopeNodes).toHaveBeenCalledWith(["R", "A", "F", "R"]);
    up.nodes.F = file("F", "R");
    expect(await proveMove(up.host, upToR()))
      .toEqual({ at: "destination", file: up.nodes.F, source: A, destination: R });
  });

  it("proves nothing for a folder binding's move outside what its saved path reaches", async () => {
    // A path that does not start at the bound root is refused before Drive is asked.
    for (let folderIds of [["A"], [], undefined]) {
      let { host, api } = harness(AT_R);
      let { folderIds: _saved, ...pathless } = intoBFromA();
      let payload = folderIds ? { ...pathless, folderIds } : pathless;
      expect(await proveMove(host, payload), String(folderIds)).toBeUndefined();
      expect(api.getScopeNodes, String(folderIds)).not.toHaveBeenCalled();
    }

    let cases: [string, (nodes: Tree) => void, DriveMoveActions["moveFile"]][] = [
      ["the positioned folder left the bound root",
        nodes => { nodes.A = folder("A", "elsewhere"); }, intoBFromA()],
      ["the positioned folder is in the trash",
        nodes => { nodes.A = { ...nodes.A, trashed: true }; }, intoBFromA()],
      // The file is in the positioned folder, and the move names another folder to take it out of.
      ["the folder to leave is not the positioned one",
        nodes => { nodes.C = folder("C", "R"); }, intoBFromA({ fromFolderId: "C" })],
      ["the destination is a grandchild",
        nodes => { nodes.G = folder("G", "B"); }, intoBFromA({ toFolderId: "G" })],
      ["the destination is a sibling of the positioned folder",
        nodes => { nodes.C = folder("C", "R"); }, intoBFromA({ toFolderId: "C" })],
      ["the destination is above the bound root",
        nodes => { nodes.above = folder("above", "top"); }, intoBFromA({ toFolderId: "above" })],
      ["the destination is the positioned folder itself", () => {}, intoBFromA({ toFolderId: "A" })],
      ["the destination cannot be listed",
        nodes => { nodes.B = { ...nodes.B, canListChildren: false }; }, intoBFromA()],
      ["the destination is in the trash",
        nodes => { nodes.B = { ...nodes.B, trashed: true }; }, intoBFromA()],
      ["the destination is a file",
        nodes => { nodes.B = file("B", "A"); }, intoBFromA()],
      ["the file is elsewhere",
        nodes => { nodes.C = folder("C", "R"); nodes.F = file("F", "C"); }, intoBFromA()],
      ["the file is in the trash",
        nodes => { nodes.F = { ...nodes.F, trashed: true }; }, intoBFromA()],
      ["the file is in the trash in the folder it was to enter",
        nodes => { nodes.F = { ...file("F", "B"), trashed: true }; }, intoBFromA()],
    ];
    for (let [what, change, payload] of cases) {
      let { host, nodes, api } = harness(AT_R);
      change(nodes);
      expect(await proveMove(host, payload), what).toBeUndefined();
      expect(api.getScopeNodes, what).toHaveBeenCalledTimes(1);
    }
    for (let invisible of ["R", "A", "F", "B"]) {
      let { host, hide, api } = harness(AT_R);
      hide(invisible);
      expect(await proveMove(host, intoBFromA()), invisible).toBeUndefined();
      expect(api.getScopeNodes, invisible).toHaveBeenCalledTimes(1);
    }

    // The bound root has no folder above it on its path: nothing is a destination up from it.
    let root = harness(AT_R);
    root.nodes.F = file("F", "R");
    let fromRoot = { fileId: "F", fromFolderId: "R", toFolderId: "above", folderIds: ["R"] };
    root.nodes.above = folder("above", "top");
    expect(await proveMove(root.host, fromRoot)).toBeUndefined();
    expect(await proveMove(root.host, { ...fromRoot, toFolderId: "A" })).toEqual({
      at: "source", file: root.nodes.F, source: root.nodes.R, destination: root.nodes.A,
    });
  });
});

describe("Drive move checks at apply", () => {
  it("moves a file exactly as approved, and keeps nothing of it", async () => {
    for (let [scope, payload, into] of [
      [ACCOUNT, intoB(), "B"], [AT_R, intoBFromA(), "B"], [AT_R, upToR(), "R"],
    ] as const) {
      let { api, journal, attempts, nodes, submit, apply, relocate } = harness(scope);
      let id = await submit(payload);
      // The record is claimed before the send, so that a crash between the send and the record's
      // retirement ends as an unknown outcome and never as a second send.
      let whileSent: unknown[] = [];
      api.swapParent.mockImplementationOnce(async (...args) => {
        whileSent.push(journal.get(id)?.state);
        return relocate(...args);
      });
      expect(journal.get(id)?.state).toBe("pending");
      expect(await apply(id)).toBeNull();
      expect(whileSent).toEqual(["claimed"]);
      expect(api.swapParent).toHaveBeenCalledTimes(1);
      expect(api.swapParent).toHaveBeenCalledWith("F", { addParent: into, removeParent: "A" });
      expect(nodes.F.parents).toEqual([into]);
      // The record is retired: no payload, and nothing written at apply, is kept.
      expect(journal.get(id)).toBeUndefined();
      // A send's marker notes the time alone; the gatekeeper drops it with the settled record.
      expect(attempts.get(id)).toEqual({ at: expect.any(Number) });

      expect(await apply(id)).toBeNull();
      expect(api.swapParent).toHaveBeenCalledTimes(1);
      expect(api.getScopeNodes).toHaveBeenCalledTimes(1);
    }
  });

  it("fails a move whose file is no longer where it was", async () => {
    for (let cannotMove of [false, true]) {
      let already = harness();
      already.nodes.F = { ...file("F", "B"), canMoveItemWithinDrive: !cannotMove };
      let made = await already.submit(intoB());
      expect(await already.apply(made)).toBe(ALREADY_MOVED);
      // Nothing was sent, so each of these is a failure known to have changed nothing.
      expect(already.journal.get(made)).toEqual(failedUnsent(intoB(), ALREADY_MOVED));
      expect(already.api.swapParent).not.toHaveBeenCalled();
      expect(already.attempts.size).toBe(0);

      // Where the file is comes before what the account may still do.
      let gone = harness();
      gone.nodes.F = { ...file("F", "C"), canMoveItemWithinDrive: !cannotMove };
      let left = await gone.submit(intoB());
      expect(await gone.apply(left)).toBe(NOT_WHERE_IT_WAS);
      expect(gone.journal.get(left)).toEqual(failedUnsent(intoB(), NOT_WHERE_IT_WAS));
      expect(gone.api.swapParent).not.toHaveBeenCalled();
    }

    // A folder binding reaches a file only as a direct child of a folder on its saved path.
    let bound = harness(AT_R);
    bound.nodes.C = folder("C", "R");
    bound.nodes.F = file("F", "C");
    let id = await bound.submit(intoBFromA());
    expect(await bound.apply(id)).toBe(OUT_OF_SCOPE);
    expect(bound.journal.get(id)).toEqual(failedUnsent(intoBFromA(), OUT_OF_SCOPE));
    expect(bound.api.swapParent).not.toHaveBeenCalled();

    // An account binding that cannot see the file, or either folder.
    for (let invisible of ["F", "A", "B"]) {
      let { api, journal, submit, apply, hide } = harness();
      let unseen = await submit(intoB());
      hide(invisible);
      expect(await apply(unseen), invisible).toBe(OUT_OF_SCOPE);
      expect(journal.get(unseen), invisible).toEqual(failedUnsent(intoB(), OUT_OF_SCOPE));
      expect(api.swapParent).not.toHaveBeenCalled();
    }
  });

  it("fails a move the account can no longer make, and one of a file in the trash", async () => {
    let onAccount: [string, (nodes: Tree) => void, string][] = [
      ["the file put in the trash", nodes => { nodes.F = { ...nodes.F, trashed: true }; },
        FILE_IN_TRASH],
      // What a folder put in the trash holds can read as live for some seconds: moved out then,
      // the file would stay in the trash in the folder it enters.
      ["the folder it is in put in the trash", nodes => { nodes.A = { ...nodes.A, trashed: true }; },
        FILE_IN_TRASH],
      ["a file that does not say whether it is in the trash",
        nodes => { nodes.F = { id: "F", parents: ["A"], canMoveItemWithinDrive: true }; },
        FILE_IN_TRASH],
      // Google still reports that the account can add to a folder that is in the trash.
      ["the destination put in the trash",
        nodes => { nodes.B = { ...nodes.B, trashed: true, canAddChildren: true }; },
        DESTINATION_IN_TRASH],
      ["the destination in the trash, to an account that cannot add to it",
        nodes => { nodes.B = { ...nodes.B, trashed: true, canAddChildren: false }; },
        DESTINATION_IN_TRASH],
      ["a file the account can no longer move",
        nodes => { nodes.F = { ...nodes.F, canMoveItemWithinDrive: false }; }, CANNOT_MOVE],
      ["a file that carries no such capability",
        nodes => { nodes.F = { id: "F", parents: ["A"], trashed: false }; }, CANNOT_MOVE],
      ["a destination the account can no longer add to",
        nodes => { nodes.B = { ...nodes.B, canAddChildren: false }; }, CANNOT_MOVE],
      ["a destination in another drive",
        nodes => { nodes.B = { ...nodes.B, driveId: "team" }; }, CANNOT_MOVE],
      ["a destination that is no longer a folder",
        nodes => { nodes.B = { ...file("B", "A"), canAddChildren: true }; }, CANNOT_MOVE],
    ];
    for (let [what, change, message] of onAccount) {
      let { api, journal, attempts, nodes, submit, apply } = harness();
      let id = await submit(intoB());
      change(nodes);
      expect(await apply(id), what).toBe(message);
      // A check that refuses has sent nothing: the failure is known, with no outcome left open.
      expect(journal.get(id), what).toEqual(failedUnsent(intoB(), message));
      expect(api.swapParent, what).not.toHaveBeenCalled();
      expect(attempts.size, what).toBe(0);
    }

    // A file and a folder of one shared drive are in the same drive.
    let shared = harness();
    for (let id of ["A", "B", "F"] as const) shared.nodes[id] = { ...shared.nodes[id], driveId: "team" };
    expect(await shared.apply(await shared.submit(intoB()))).toBeNull();

    // On a folder binding a file in the trash, and a child folder in the trash, are no live
    // direct children: out of scope, as in every folder call.
    let onFolder: [string, (nodes: Tree) => void][] = [
      ["the file put in the trash", nodes => { nodes.F = { ...nodes.F, trashed: true }; }],
      ["the child folder put in the trash", nodes => { nodes.B = { ...nodes.B, trashed: true }; }],
    ];
    for (let [what, change] of onFolder) {
      let { api, journal, nodes, submit, apply } = harness(AT_R);
      let id = await submit(intoBFromA());
      change(nodes);
      expect(await apply(id), what).toBe(OUT_OF_SCOPE);
      expect(journal.get(id), what).toEqual(failedUnsent(intoBFromA(), OUT_OF_SCOPE));
      expect(api.swapParent, what).not.toHaveBeenCalled();
    }
  });

  it("asks the access level and the grant again when a move is approved", async () => {
    let readOnly = readOnlyRefusal(ACCOUNT);
    let fixed = harness();
    let failed = await fixed.submit(intoB());
    fixed.refuse(readOnly);
    expect(await fixed.apply(failed)).toBe(readOnly);
    expect(fixed.journal.get(failed)).toEqual(failedUnsent(intoB(), readOnly));
    expect(fixed.api.getScopeNodes).not.toHaveBeenCalled();
    expect(fixed.api.swapParent).not.toHaveBeenCalled();

    let { api, journal, attempts, nodes, submit, apply, refuse } = harness();
    let id = await submit(intoB());
    refuse(WRITES_GRANT_MISSING);
    expect(await apply(id)).toBe(WRITES_GRANT_MISSING);
    expect(await apply(id)).toBe(WRITES_GRANT_MISSING);
    expect(journal.get(id)?.state).toBe("pending");
    expect(api.getScopeNodes).not.toHaveBeenCalled();
    expect(api.swapParent).not.toHaveBeenCalled();
    expect(attempts.size).toBe(0);
    refuse(undefined);
    expect(await apply(id)).toBeNull();
    expect(nodes.F.parents).toEqual(["B"]);
  });
});

describe("Drive move sends and their markers", () => {
  it("finds an earlier send's move instead of moving again", async () => {
    // Google answers 400 invalidParameter for a response mask it does not accept, after the move.
    for (let lost of [unconfirmed(), new DriveApiRequestError(400, "invalidParameter")]) {
      let { api, journal, attempts, nodes, submit, apply, moveThenAnswer } = harness();
      moveThenAnswer(lost);
      let id = await submit(intoB());
      expect(await apply(id), lost.reason).toBe(UNCONFIRMED_MOVE);
      expect(journal.get(id)?.state, lost.reason).toBe("pending");
      let marker = attempts.get(id);
      expect(marker, lost.reason).toEqual({ at: expect.any(Number) });

      expect(await apply(id), lost.reason).toBeNull();
      expect(api.swapParent, lost.reason).toHaveBeenCalledTimes(1);
      expect(nodes.F.parents, lost.reason).toEqual(["B"]);
      expect(journal.get(id), lost.reason).toBeUndefined();
      expect(attempts.get(id), lost.reason).toBe(marker);
    }
  });

  it("sends again once a look finds the file where it was, however often", async () => {
    let { api, journal, attempts, nodes, submit, apply } = harness();
    api.swapParent.mockRejectedValue(unconfirmed());
    let id = await submit(intoB());
    for (let send = 1; send <= 4; send++) {
      expect(await apply(id), `send ${send}`).toBe(UNCONFIRMED_MOVE);
      expect(api.swapParent, `send ${send}`).toHaveBeenCalledTimes(send);
      // The first approval checks; each later one looks, then checks.
      expect(api.getScopeNodes, `send ${send}`).toHaveBeenCalledTimes(2 * send - 1);
      expect(journal.get(id)?.state, `send ${send}`).toBe("pending");
      expect(attempts.get(id), `send ${send}`).toEqual({ at: expect.any(Number) });
    }
    expect(nodes.F.parents).toEqual(["A"]);
  });

  // Denying always withdraws: no state a move can be left in refuses it.
  it("withdraws a move from every state approving can leave it in", async () => {
    type Run = ReturnType<typeof harness>;
    let states: [string, (run: Run) => Promise<number>][] = [
      ["never approved", run => run.submit(intoB())],
      ["a send Google did not confirm", async run => {
        run.api.swapParent.mockRejectedValueOnce(unconfirmed());
        let id = await run.submit(intoB());
        expect(await run.apply(id)).toBe(UNCONFIRMED_MOVE);
        return id;
      }],
      ["an outcome that cannot be told", async run => {
        run.api.swapParent.mockRejectedValueOnce(unconfirmed());
        let id = await run.submit(intoB());
        expect(await run.apply(id)).toBe(UNCONFIRMED_MOVE);
        run.nodes.F = file("F", "C");
        expect(await run.apply(id)).toBe(MOVED_AGAIN);
        return id;
      }],
      ["failed for good at a check", async run => {
        let id = await run.submit(intoB());
        run.refuse("This Google Drive connection is read-only.");
        expect(await run.apply(id)).toBe("This Google Drive connection is read-only.");
        return id;
      }],
      ["an approval interrupted after its claim", async run => {
        let id = await run.submit(intoB());
        run.journal.markClaimed(id);
        return id;
      }],
    ];
    for (let [name, reach] of states) {
      let run = harness();
      let id = await reach(run);
      let sends = run.api.swapParent.mock.calls.length;
      await expect(run.actions.reject(id), name).resolves.toBeUndefined();
      expect(run.journal.get(id), name).toBeUndefined();
      expect(run.journal.listPending(), name).toEqual([]);
      expect(run.api.swapParent, name).toHaveBeenCalledTimes(sends);
    }
  });

  it("ends as of unknown outcome when a look finds the file in neither folder, or cannot see it", async () => {
    let again = harness();
    again.api.swapParent.mockRejectedValueOnce(unconfirmed());
    let moved = await again.submit(intoB());
    expect(await again.apply(moved)).toBe(UNCONFIRMED_MOVE);
    let marker = again.attempts.get(moved);
    again.nodes.F = file("F", "C");
    expect(await again.apply(moved)).toBe(MOVED_AGAIN);
    expect(again.journal.get(moved)).toMatchObject({ state: "failed", outcome: "unknown" });
    expect(again.attempts.get(moved)).toBe(marker);
    // The kit answers a settled failure from what it stored: nothing is read or sent again.
    again.nodes.F = file("F", "A");
    expect(await again.apply(moved)).toBe(MOVED_AGAIN);
    expect(again.api.getScopeNodes).toHaveBeenCalledTimes(2);
    expect(again.api.swapParent).toHaveBeenCalledTimes(1);

    for (let invisible of ["F", "A", "B"]) {
      let { api, journal, attempts, submit, apply, hide } = harness();
      api.swapParent.mockRejectedValueOnce(unconfirmed());
      let id = await submit(intoB());
      expect(await apply(id), invisible).toBe(UNCONFIRMED_MOVE);
      hide(invisible);
      expect(await apply(id), invisible).toBe(NO_LONGER_SHOWN);
      expect(journal.get(id), invisible).toMatchObject({ state: "failed", outcome: "unknown" });
      expect(attempts.has(id), invisible).toBe(true);
      expect(api.swapParent, invisible).toHaveBeenCalledTimes(1);
    }

    // On a folder binding a file in neither folder is outside what the saved path proves.
    let bound = harness(AT_R);
    bound.api.swapParent.mockRejectedValueOnce(unconfirmed());
    let id = await bound.submit(intoBFromA());
    expect(await bound.apply(id)).toBe(UNCONFIRMED_MOVE);
    bound.nodes.C = folder("C", "R");
    bound.nodes.F = file("F", "C");
    expect(await bound.apply(id)).toBe(NO_LONGER_SHOWN);
    expect(bound.journal.get(id)).toMatchObject({ state: "failed", outcome: "unknown" });

    // A look does not ask whether the file is in the trash: it is still in one of the two folders.
    let trashed = harness();
    trashed.moveThenAnswer(unconfirmed());
    let binned = await trashed.submit(intoB());
    expect(await trashed.apply(binned)).toBe(UNCONFIRMED_MOVE);
    trashed.nodes.F = { ...file("F", "B"), trashed: true };
    expect(await trashed.apply(binned)).toBeNull();
    expect(trashed.api.swapParent).toHaveBeenCalledTimes(1);
  });

  it("leaves the outcome open when Google answers a move with other parents than the folder asked for", async () => {
    for (let parents of [["A"], ["B", "A"], ["C"]]) {
      let { api, journal, attempts, submit, apply } = harness();
      api.swapParent.mockResolvedValueOnce({ id: "F", parents });
      let id = await submit(intoB());
      expect(await apply(id), String(parents)).toBe(UNCONFIRMED_MOVE);
      expect(journal.get(id)?.state, String(parents)).toBe("pending");
      expect(attempts.has(id), String(parents)).toBe(true);
    }
  });

  it("keeps a move pending when Google stops accepting the approval's token", async () => {
    let { api, journal, attempts, nodes, submit, apply } = harness();
    api.swapParent.mockRejectedValueOnce(new DriveApiRequestError(401));
    let id = await submit(intoB());
    expect(await apply(id)).toBe(CREDENTIALS_NOT_ACCEPTED);
    expect(journal.get(id)?.state).toBe("pending");
    expect(attempts.get(id)).toEqual({ at: expect.any(Number) });
    expect(nodes.F.parents).toEqual(["A"]);

    // The next approval looks, finds the file where it was, and moves it.
    expect(await apply(id)).toBeNull();
    expect(api.getScopeNodes).toHaveBeenCalledTimes(3);
    expect(api.swapParent).toHaveBeenCalledTimes(2);
    expect(nodes.F.parents).toEqual(["B"]);
  });

  it("keeps a rate-limited move pending with its marker, so the next approval looks first", async () => {
    let { api, journal, attempts, nodes, submit, apply, moveThenAnswer } = harness();
    // Were the send to have moved the file all the same, the look finds it and the move applies.
    moveThenAnswer(new DriveApiRequestError(429, "rateLimitExceeded"));
    let id = await submit(intoB());
    expect(await apply(id)).toBe(RATE_LIMITED);
    expect(journal.get(id)?.state).toBe("pending");
    expect(attempts.get(id)).toEqual({ at: expect.any(Number) });
    expect(await apply(id)).toBeNull();
    expect(api.swapParent).toHaveBeenCalledTimes(1);
    expect(nodes.F.parents).toEqual(["B"]);
  });

  it("keeps a move pending, with its marker, when the look cannot read for a missing scope", async () => {
    // A batch part Google refuses for a missing scope reads as a file the account cannot see.
    let unreadable: [string, (api: ReturnType<typeof harness>["api"]) => void][] = [
      ["every part refused", api => {
        api.getScopeNodes.mockResolvedValueOnce([undefined, undefined, undefined]);
      }],
      ["the read refused", api => { api.getScopeNodes.mockRejectedValueOnce(missingScope()); }],
    ];
    for (let [what, refuseRead] of unreadable) {
      let { api, journal, attempts, nodes, submit, apply, refuse, moveThenAnswer } = harness();
      moveThenAnswer(unconfirmed());
      let id = await submit(intoB());
      expect(await apply(id), what).toBe(UNCONFIRMED_MOVE);
      let marker = attempts.get(id);

      refuseRead(api);
      refuse(WRITES_GRANT_MISSING);
      expect(await apply(id), what).toBe(WRITES_GRANT_MISSING);
      expect(journal.get(id)?.state, what).toBe("pending");
      expect(attempts.get(id), what).toBe(marker);
      expect(api.swapParent, what).toHaveBeenCalledTimes(1);

      // With the scope and the grant back, the look finds what the first send made.
      refuse(undefined);
      expect(await apply(id), what).toBeNull();
      expect(api.swapParent, what).toHaveBeenCalledTimes(1);
      expect(nodes.F.parents, what).toEqual(["B"]);
    }
  });

  it("takes a look that proves nothing for a file that is gone only when no later approval could read it", async () => {
    // A read-only binding's refusal is not one a later approval can pass.
    let fixed = harness();
    fixed.api.swapParent.mockRejectedValueOnce(unconfirmed());
    let gone = await fixed.submit(intoB());
    expect(await fixed.apply(gone)).toBe(UNCONFIRMED_MOVE);
    fixed.hide("F");
    fixed.refuse(readOnlyRefusal(ACCOUNT));
    expect(await fixed.apply(gone)).toBe(NO_LONGER_SHOWN);
    expect(fixed.journal.get(gone)).toMatchObject({ state: "failed", outcome: "unknown" });

    // A read refused for the scope while the account holds the grant is passed on as it came.
    let { api, journal, attempts, submit, apply, refuse } = harness();
    api.swapParent.mockRejectedValueOnce(unconfirmed());
    let id = await submit(intoB());
    expect(await apply(id)).toBe(UNCONFIRMED_MOVE);
    api.getScopeNodes.mockRejectedValueOnce(missingScope());
    expect(await apply(id)).toMatch(/403/);
    expect(journal.get(id)?.state).toBe("pending");
    expect(attempts.has(id)).toBe(true);

    // So is any other failure of the look, a 401 among them: it decides nothing. That holds while
    // the account lacks the grant too: the grant is asked about for a missing scope alone, so a
    // failure it does not explain is never said as the grant's.
    for (let grant of [undefined, WRITES_GRANT_MISSING]) {
      refuse(grant);
      for (let status of [401, 500]) {
        let what = `${status}${grant === undefined ? "" : ", without the grant"}`;
        let failure = new DriveApiRequestError(status);
        api.getScopeNodes.mockRejectedValueOnce(failure);
        expect(await apply(id), what).toBe(failure.message);
        expect(failure.message, what).toContain(String(status));
        expect(journal.get(id)?.state, what).toBe("pending");
        expect(attempts.has(id), what).toBe(true);
      }
    }
    // One read for the first approval's check, then one for each look: none reached a check.
    expect(api.getScopeNodes).toHaveBeenCalledTimes(6);
    expect(api.swapParent).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, "badRequest",
      "Google Drive refused this move as invalid. A folder cannot be moved into itself or into " +
      "a folder inside it."],
    [403, "parentNotAFolder", "The destination is not a folder."],
    [404, "notFound",
      "Google Drive no longer shows the file or the destination folder to the connected account."],
    [403, "insufficientFilePermissions", CANNOT_MOVE],
    [403, "teamDrivesFolderMoveInNotSupported",
      "Google does not allow that folder to be moved into a shared drive."],
    [403, "teamDriveHierarchyTooDeep", "That would nest folders deeper than a shared drive allows."],
    [403, "teamDriveFileLimitExceeded",
      "That shared drive already holds as many items as Google allows."],
    [403, "storageQuotaExceeded", "There is no Drive storage left for this move."],
    [403, "domainPolicy",
      "Your organization's administrator does not allow this app to use Google Drive."],
    [403, "somethingNew", "Google Drive refused this move."],
    [400, "invalid", "Google Drive refused this move."],
    // A reason known for another status is not that row's.
    [403, "badRequest", "Google Drive refused this move."],
  ])("turns Google's refusal into words and keeps its code: %i %s", async (status, reason, message) => {
    let { api, journal, attempts, nodes, submit, apply } = harness();
    api.swapParent.mockRejectedValueOnce(new DriveApiRequestError(status, reason));
    let id = await submit(intoB());
    expect(await apply(id)).toBe(`${message} [http=${status} reason=${reason}]`);
    expect(journal.get(id)?.state).toBe("failed");
    // A refusal changed nothing, so no send of it is in doubt.
    expect(attempts.has(id)).toBe(false);
    expect(nodes.F.parents).toEqual(["A"]);
    expect(api.swapParent).toHaveBeenCalledTimes(1);
  });

  it("keeps the status of a refusal Google gave no reason for, and says when the Drive API is off", async () => {
    let bare = harness();
    bare.api.swapParent.mockRejectedValueOnce(new DriveApiRequestError(403));
    expect(await bare.apply(await bare.submit(intoB())))
      .toBe("Google Drive refused this move. [http=403]");

    let disabled = harness();
    disabled.api.swapParent.mockRejectedValueOnce(new DriveApiDisabledError("disabled"));
    let id = await disabled.submit(intoB());
    expect(await disabled.apply(id)).toBe(
      "The Google Drive API is not enabled for this deployment's Google project. " +
      "[http=403 reason=accessNotConfigured]");
    expect(disabled.journal.get(id)?.state).toBe("failed");
  });
});

describe("Drive moves awaiting a decision", () => {
  it("finds a queued move of any file or folder asked about, and of nothing else", () => {
    let move: QueuedWrite = {
      id: 3,
      action: {
        kind: "moveFile",
        payload: { fileId: "A", isFolder: true, fromFolderId: "R", toFolderId: "B", folderIds: ["R"] },
      },
    };
    expect(hasPendingMove(["A"], [move])).toBe(true);
    // The IDs a write for `D0` under the saved path R, A is proved along.
    expect(hasPendingMove(["R", "A", "D0"], [move])).toBe(true);
    // A move into a folder, or out of one, is not a move of it.
    expect(hasPendingMove(["B"], [move])).toBe(false);
    expect(hasPendingMove(["R"], [move])).toBe(false);
    expect(hasPendingMove(["D0"], [move])).toBe(false);
    expect(hasPendingMove([], [move])).toBe(false);
    expect(hasPendingMove(["A"], [])).toBe(false);

    // Another kind of write for the same folder is no move of it.
    let others: QueuedWrite[] = [
      { id: 1, action: { kind: "createPermission", payload: { fileId: "A" } } },
      { id: 2, action: { kind: "createComment", payload: { fileId: "A" } } },
      // A kind named as an inherited property is no definition's.
      { id: 4, action: { kind: "toString", payload: { fileId: "A" } } },
    ];
    expect(hasPendingMove(["A"], others)).toBe(false);
    expect(hasPendingMove(["A"], [...others, move])).toBe(true);
  });

  it("words the refusals behind a waiting move", () => {
    expect(MOVE_PENDING).toBe(
      "That file already has a move waiting for approval. To move it somewhere else instead, " +
      "have the user reject that move first.");
    expect(MOVE_WAITING).toBe(
      "That file, or a folder it is in, has a move waiting for approval, which takes it out of " +
      "where this binding reaches it now. Queue this once the move is decided, from the folder " +
      "the file is then in.");
    expect(MOVE_DESTINATION_WAITING).toBe(
      "That destination folder has a move waiting for approval. Queue this once that move is " +
      "decided.");
  });
});

describe("Drive move logs", () => {
  it("logs IDs and outcomes only", async () => {
    let spies = (["debug", "info", "warn", "error"] as const)
      .map(level => vi.spyOn(console, level).mockImplementation(() => {}));
    let ids: number[] = [];
    /** A harness whose file and folders have IDs no other text holds, and a move between them. */
    let named = async (scope: DriveBindingScope = ACCOUNT) => {
      let made = harness(scope);
      made.nodes["fld-from"] = folder("fld-from", "R");
      made.nodes["fld-to"] = folder("fld-to", "fld-from");
      made.nodes["doc-9"] = file("doc-9", "fld-from");
      let id = await made.submit({
        fileId: "doc-9", fileName: "Budget 2026", fromFolderId: "fld-from", fromName: "Finance",
        toFolderId: "fld-to", toName: "Archive",
        ...(scope.kind === "folder" ? { folderIds: ["R", "fld-from"] } : {}),
      });
      ids.push(id);
      return { ...made, id };
    };

    // Applied, on each binding.
    for (let scope of [ACCOUNT, AT_R]) {
      let applied = await named(scope);
      expect(await applied.apply(applied.id)).toBeNull();
    }
    // A send Drive did not confirm, found by the next approval's look.
    let lost = await named();
    lost.moveThenAnswer(unconfirmed());
    expect(await lost.apply(lost.id)).toBe(UNCONFIRMED_MOVE);
    expect(await lost.apply(lost.id)).toBeNull();
    // A refusal, a rate limit, a token not accepted and an answer for other parents.
    let refused = await named();
    refused.api.swapParent.mockRejectedValueOnce(new DriveApiRequestError(403, "parentNotAFolder"));
    expect(await refused.apply(refused.id)).toMatch(/^The destination is not a folder\./);
    let limited = await named();
    limited.api.swapParent.mockRejectedValueOnce(new DriveApiRequestError(429, "rateLimitExceeded"));
    expect(await limited.apply(limited.id)).toBe(RATE_LIMITED);
    let unauthorized = await named();
    unauthorized.api.swapParent.mockRejectedValueOnce(new DriveApiRequestError(401));
    expect(await unauthorized.apply(unauthorized.id)).toBe(CREDENTIALS_NOT_ACCEPTED);
    let odd = await named();
    odd.api.swapParent.mockResolvedValueOnce({ id: "doc-9", parents: ["fld-from"] });
    expect(await odd.apply(odd.id)).toBe(UNCONFIRMED_MOVE);
    // Checks that fail the move, and looks that end it as of unknown outcome.
    let binned = await named();
    binned.nodes["doc-9"] = { ...file("doc-9", "fld-from"), trashed: true };
    expect(await binned.apply(binned.id)).toBe(FILE_IN_TRASH);
    let outside = await named(AT_R);
    outside.nodes["doc-9"] = file("doc-9", "R");
    expect(await outside.apply(outside.id)).toBe(OUT_OF_SCOPE);
    let again = await named();
    again.api.swapParent.mockRejectedValueOnce(unconfirmed());
    expect(await again.apply(again.id)).toBe(UNCONFIRMED_MOVE);
    again.nodes["doc-9"] = file("doc-9", "R");
    expect(await again.apply(again.id)).toBe(MOVED_AGAIN);
    let unseen = await named();
    unseen.api.swapParent.mockRejectedValueOnce(unconfirmed());
    expect(await unseen.apply(unseen.id)).toBe(UNCONFIRMED_MOVE);
    unseen.hide("fld-to");
    expect(await unseen.apply(unseen.id)).toBe(NO_LONGER_SHOWN);

    let lines = spies.flatMap(spy => spy.mock.calls.map(([line]): Record<string, unknown> => {
      expect(typeof line === "object" && line !== null).toBe(true);
      // A stack is the code's own text under the error's, which `error` carries.
      let { errorStack: _stack, ...fields } = line as Record<string, unknown>;
      return fields;
    }));
    let own = lines.filter(line => line.component === "gatekeeper.google.drive.moves");
    expect(own.map(line => [line.event, line.outcome])).toEqual([
      ["drive.moves.applied", "applied"],
      ["drive.moves.applied", "applied"],
      ["drive.moves.reconciled", "found"],
      ["drive.moves.send.failed", "unknown"],
      ["drive.moves.send.failed", "absent"],
      ["drive.moves.send.failed", "rateLimited"],
      ["drive.moves.send.failed", "unauthorized"],
      ["drive.moves.send.failed", "unknown"],
      ["drive.moves.send.failed", "unknown"],
      ["drive.moves.send.failed", "unknown"],
    ]);
    let allowed = new Set([
      "component", "vendorId", "actionId", "actionKind", "fileId", "event", "outcome", "message",
      "error", "httpStatus", "providerReasons",
    ]);
    for (let line of own) {
      expect(line).toMatchObject({ vendorId: "google", actionKind: "moveFile", fileId: "doc-9" });
      expect(ids).toContain(line.actionId);
      expect(Object.keys(line).filter(key => !allowed.has(key))).toEqual([]);
    }
    expect(own.find(line => line.outcome === "absent")).toMatchObject({
      httpStatus: 403, providerReasons: ["parentNotAFolder"],
    });

    // No line, the kit's own among them, holds a name or the ID of a folder.
    let text = JSON.stringify(lines);
    for (let kept of ["Budget 2026", "Finance", "Archive", "fld-from", "fld-to"]) {
      expect(text).not.toContain(kept);
    }
    expect(text).toContain("doc-9");
  });
});
