import { ActionJournal, defineActions } from "@gadgets/gatekeeper-kit/actions";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DriveApiDisabledError, DriveApiRequestError, FOLDER_MIME_TYPE, type DriveApi,
  type DriveScopeNode,
} from "../src/drive-api";
import {
  DRIVE_RENAME_DEFINITIONS, DRIVE_RENAMES, hasPendingRename, newFileName, RENAME_PENDING,
  type DriveRenameAction, type DriveRenameActions,
} from "../src/drive-renames";
import type { DriveBindingScope } from "../src/drive-session";
import {
  CREDENTIALS_NOT_ACCEPTED, readOnlyRefusal, WRITES_GRANT_MISSING, type DriveWritesHost,
  type QueuedWrite, type WriteAttempt,
} from "../src/drive-writes";
import { FakeKv } from "./fake-kv";

const KIND = { tag: "driveRenames", label: "Drive renames" };
const ACCOUNT: DriveBindingScope = { kind: "account" };
const FILE_F: DriveBindingScope = { kind: "file", fileId: "F" };
const AT_R: DriveBindingScope = { kind: "folder", folderId: "R" };

const OUT_OF_SCOPE = "That file is no longer in this connection's scope.";
const FILE_IN_TRASH = "That file is in the trash, so it was not renamed.";
const ALREADY_RENAMED =
  "That file was already given that name after this was queued, so nothing was changed.";
const RENAMED_SINCE = "That file was renamed after this was queued, so it was not renamed again.";
const CANNOT_RENAME = "The connected account can no longer rename that file.";
const UNCONFIRMED_RENAME =
  "Google Drive did not confirm whether this was renamed, and it may have been. Approving it " +
  "again first checks the file's name; rejecting it leaves the file named as it is.";
const RENAMED_AGAIN =
  "This file was renamed again on Google Drive after this was first sent, so its name was left " +
  "as it is. Check its name, then reject this to clear it.";
const NO_LONGER_SHOWN =
  "Google Drive no longer shows this file to the connected account where this connection " +
  "reaches it, so whether it was renamed can't be checked, and it won't be renamed again. " +
  "Reject it to clear it.";
const RATE_LIMITED =
  "Google Drive is limiting requests from this account. Approve it again in a minute.";

/** A live folder the account can list and rename, as a scope proof reads it. */
function folder(id: string, parent: string): DriveScopeNode {
  return {
    id, mimeType: FOLDER_MIME_TYPE, parents: [parent], trashed: false, canListChildren: true,
    canRename: true,
  };
}

/** A live file the account can rename, as a scope proof reads it. */
function file(id: string, parent: string): DriveScopeNode {
  return { id, mimeType: "application/pdf", parents: [parent], trashed: false, canRename: true };
}

/** Folder `R` holds folder `A` ("Finance"), which holds file `F` ("Budget 2026"). */
function tree(): Record<string, DriveScopeNode | undefined> {
  return { R: folder("R", "above"), A: folder("A", "R"), F: file("F", "A") };
}

/** A rename of `F`, as an account or file binding queues it. */
function renameF(
  overrides: Partial<DriveRenameActions["renameFile"]> = {},
): DriveRenameActions["renameFile"] {
  return { fileId: "F", fromName: "Budget 2026", toName: "Budget 2027", ...overrides };
}

/** The same rename as a folder binding at `R` queues it from the session opened at `A`. */
function renameFFromA(): DriveRenameActions["renameFile"] {
  return renameF({ folderIds: ["R", "A"] });
}

/** A rename of `A` itself, from the session opened at it. */
function renameA(): DriveRenameActions["renameFile"] {
  return {
    fileId: "A", folderIds: ["R", "A"], self: true, isFolder: true, fromName: "Finance",
    toName: "Finance 2027",
  };
}

/** The record of a rename that failed for good with nothing sent. */
function failedUnsent(payload: DriveRenameActions["renameFile"], error: string) {
  return { state: "failed", action: { kind: "renameFile", payload }, error };
}

/** Drive's answer to a send whose outcome it leaves open. */
const unconfirmed = () => new DriveApiRequestError(503, "backendError");
/** Drive's refusal of a token that lacks the scope a request needs. */
const missingScope = () => new DriveApiRequestError(403, "insufficientPermissions");

afterEach(() => {
  vi.restoreAllMocks();
});

/** The rename definitions as a set of their own; the gatekeeper binds them among the others. */
const RENAME_ACTIONS = defineActions<DriveWritesHost, DriveRenameActions>(
  DRIVE_RENAME_DEFINITIONS, { fence: "none", vendorId: "google" });

/** A Drive call no rename makes. */
const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected call");
};

/** The Docs API, through which no rename is sent. */
const NO_DOCS: DriveWritesHost["docs"] = {
  getDocumentWithSuggestions: unexpected,
  getRevisionId: unexpected,
  insertComment: unexpected,
  suggest: unexpected,
  replyToSuggestion: unexpected,
};

/**
 * The rename set bound over an in-memory journal, with a host whose reads answer from a tree and
 * a set of names a test can change, and whose rename rewrites the name.
 */
function harness(scope: DriveBindingScope = ACCOUNT) {
  let nodes = tree();
  let names: Record<string, string> = { R: "Bound", A: "Finance", F: "Budget 2026" };
  let hidden = new Set<string>();
  let attempts = new Map<number, WriteAttempt>();
  let refused: string | undefined;
  let described: ActionDescription | undefined;
  /** What Drive does with a rename. */
  let setName: DriveApi["renameFile"] = async (fileId, name) => {
    if (!nodes[fileId]) throw new DriveApiRequestError(404, "notFound");
    names[fileId] = name;
    return { id: fileId, name };
  };
  let api = {
    // As Drive answers a batch: a name only for the one file the read names.
    getScopeNodes: vi.fn<DriveApi["getScopeNodes"]>(async (ids, options) => ids.map(id => {
      let node = nodes[id];
      if (!node || hidden.has(id)) return undefined;
      return { ...structuredClone(node), ...(id === options?.nameOf ? { name: names[id] } : {}) };
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
    swapParent: vi.fn<DriveApi["swapParent"]>(unexpected),
    renameFile: vi.fn<DriveApi["renameFile"]>(setName),
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
  let journal = new ActionJournal<DriveRenameAction>(new FakeKv(), { namespace: "drive" });
  let actions = RENAME_ACTIONS.bind(journal, host);
  let queue = {
    submitAction: async (_id: number, description: ActionDescription) => { described = description; },
  };
  let submit = (payload: DriveRenameActions["renameFile"]) =>
    actions.submit(queue, "renameFile", payload);
  return {
    api, journal, actions, attempts, nodes, names, submit,
    /** Submits one rename and returns what its approval shows. */
    async card(payload: DriveRenameActions["renameFile"]): Promise<ActionDescription> {
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
    /** Makes the next send rename the file and then answer `error`. */
    renameThenAnswer(error: Error): void {
      api.renameFile.mockImplementationOnce(async (...args) => {
        await setName(...args);
        throw error;
      });
    },
  };
}

describe("Drive rename verdict and approval card", () => {
  it("declares an auto-approvable kind of its own, awaits its decision and says it cannot be reverted", async () => {
    let { actions, card } = harness();
    expect(DRIVE_RENAMES).toEqual(KIND);
    expect(await card(renameF())).toMatchObject({
      autoApprovable: true, actionKind: KIND, awaitDecision: true, implementsRevert: false,
    });
    expect(actions.autoApprovableKinds()).toEqual([KIND]);
  });

  it("names the file in prose and both names in fields", async () => {
    let aFile = await harness().card(renameF());
    expect(aFile.title).toBe("Rename a Google Drive file");
    expect(aFile.description).toBe("Rename Google Drive file `F`.");
    expect(aFile.fields).toEqual([
      { label: "File", kind: "inline", value: "F" },
      { label: "Current name", kind: "inline", value: "Budget 2026" },
      { label: "New name", kind: "inline", value: "Budget 2027" },
    ]);
    expect(aFile.descriptionIsComplete).toBe(true);

    let aFolder = await harness(AT_R).card(renameA());
    expect(aFolder.title).toBe("Rename a Google Drive folder");
    expect(aFolder.description).toBe("Rename Google Drive folder `A`.");
  });

  it("keeps names in fields, whatever they hold", async () => {
    let fromName = "Plan\n# Approved";
    let toName = "[Archive](https://example.com/x) <img src=x>";
    let description = await harness().card(renameF({ fromName, toName }));
    expect(description.description).toBe("Rename Google Drive file `F`.");
    expect(description.title).toBe("Rename a Google Drive file");
    expect(description.fields).toEqual([
      { label: "File", kind: "inline", value: "F" },
      // A name one line cannot show exactly is shown as text, whole.
      { label: "Current name", kind: "text", value: fromName },
      { label: "New name", kind: "inline", value: toName },
    ]);
  });
});

describe("Drive rename names", () => {
  it("trims a name and takes one line of 1 to 256 characters", () => {
    expect(newFileName("  Budget 2027 ")).toBe("Budget 2027");
    expect(newFileName("x".repeat(256))).toBe("x".repeat(256));
    let refusal = "A Google Drive file or folder needs a one-line name of 1 to 256 characters.";
    for (let name of ["", "   ", "x".repeat(257), "a\nb", "a\tb", "a b", "a\u0000b"]) {
      expect(() => newFileName(name), JSON.stringify(name)).toThrow(refusal);
    }
  });
});

describe("Drive rename proofs and checks at apply", () => {
  it("renames a file exactly as approved on each binding, and keeps nothing of it", async () => {
    for (let [scope, payload] of [
      [ACCOUNT, renameF()], [FILE_F, renameF()], [AT_R, renameFFromA()], [AT_R, renameA()],
    ] as const) {
      let what = `${scope.kind} ${payload.fileId}`;
      let { api, journal, attempts, names, submit, apply } = harness(scope);
      let id = await submit(payload);
      // The record is claimed before the send, so that a crash between the send and the record's
      // retirement ends as an unknown outcome and never as a second send.
      let whileSent: unknown[] = [];
      api.renameFile.mockImplementationOnce(async (fileId, name) => {
        whileSent.push(journal.get(id)?.state);
        names[fileId] = name;
        return { id: fileId, name };
      });
      expect(await apply(id), what).toBeNull();
      expect(whileSent, what).toEqual(["claimed"]);
      expect(api.renameFile.mock.calls, what).toEqual([[payload.fileId, payload.toName]]);
      expect(names[payload.fileId], what).toBe(payload.toName);
      expect(journal.get(id), what).toBeUndefined();
      expect(attempts.get(id), what).toEqual({ at: expect.any(Number) });

      expect(await apply(id), what).toBeNull();
      expect(api.renameFile, what).toHaveBeenCalledTimes(1);
    }
  });

  it("fails a rename whose file is no longer in the binding's scope", async () => {
    let cases: [string, DriveBindingScope, DriveRenameActions["renameFile"],
      (run: ReturnType<typeof harness>) => void][] = [
      ["an account binding's file Drive no longer shows", ACCOUNT, renameF(), run => run.hide("F")],
      ["another file than a file binding's", FILE_F, renameF({ fileId: "G" }), () => {}],
      ["the positioned folder on a binding that has none", ACCOUNT, renameA(), () => {}],
      ["a child moved out of the folder", AT_R, renameFFromA(),
        run => { run.nodes.F = file("F", "R"); }],
      ["a child in the trash", AT_R, renameFFromA(),
        run => { run.nodes.F = { ...file("F", "A"), trashed: true }; }],
      ["a folder moved off the saved path", AT_R, renameA(),
        run => { run.nodes.A = folder("A", "elsewhere"); }],
      ["a saved path that does not start at the bound root", AT_R,
        { ...renameFFromA(), folderIds: ["A"] }, () => {}],
    ];
    for (let [what, scope, payload, change] of cases) {
      let run = harness(scope);
      let id = await run.submit(payload);
      change(run);
      expect(await run.apply(id), what).toBe(OUT_OF_SCOPE);
      expect(run.journal.get(id), what).toEqual(failedUnsent(payload, OUT_OF_SCOPE));
      expect(run.api.renameFile, what).not.toHaveBeenCalled();
      expect(run.attempts.size, what).toBe(0);
    }
  });

  it("fails a rename of a file in the trash, renamed meanwhile, or the account can no longer rename", async () => {
    let cases: [string, string, (run: ReturnType<typeof harness>) => void][] = [
      ["in the trash", FILE_IN_TRASH, run => { run.nodes.F = { ...file("F", "A"), trashed: true }; }],
      ["not said to be live", FILE_IN_TRASH,
        run => { run.nodes.F = { id: "F", mimeType: "application/pdf", canRename: true }; }],
      ["already renamed", ALREADY_RENAMED, run => { run.names.F = "Budget 2027"; }],
      ["renamed to something else", RENAMED_SINCE, run => { run.names.F = "Budget (old)"; }],
      ["not renamable", CANNOT_RENAME, run => { run.nodes.F = { ...file("F", "A"), canRename: false }; }],
      ["not said to be renamable", CANNOT_RENAME,
        run => { run.nodes.F = { id: "F", parents: ["A"], trashed: false }; }],
    ];
    for (let [what, refusal, change] of cases) {
      let run = harness();
      let id = await run.submit(renameF());
      change(run);
      expect(await run.apply(id), what).toBe(refusal);
      expect(run.journal.get(id), what).toEqual(failedUnsent(renameF(), refusal));
      expect(run.api.renameFile, what).not.toHaveBeenCalled();
      expect(run.attempts.size, what).toBe(0);
    }

    // What the file is called comes before what the account may still do.
    let both = harness();
    let id = await both.submit(renameF());
    both.names.F = "Budget 2027";
    both.nodes.F = { ...file("F", "A"), canRename: false };
    expect(await both.apply(id)).toBe(ALREADY_RENAMED);
  });

  // A scope node carries no name, except the one a read names: a rename's target is named in the
  // batch that proves the scope, so its name and where it is are one read's, and no folder on the
  // path is read for its name.
  it("reads the target's name in the batch that proves its scope, and no other name", async () => {
    for (let [scope, payload, batch] of [
      [ACCOUNT, renameF(), ["F"]], [FILE_F, renameF(), ["F"]],
      [AT_R, renameFFromA(), ["R", "A", "F"]], [AT_R, renameA(), ["R", "A"]],
    ] as const) {
      let what = `${scope.kind} ${payload.fileId}`;
      let run = harness(scope);
      let id = await run.submit(payload);
      expect(await run.apply(id), what).toBeNull();
      expect(run.api.getScopeNodes.mock.calls, what)
        .toEqual([[batch, { nameOf: payload.fileId }]]);
    }

    // A name Drive leaves out decides nothing: the rename stays pending, with nothing sent.
    let unnamed = harness();
    let id = await unnamed.submit(renameF());
    unnamed.api.getScopeNodes.mockResolvedValueOnce([file("F", "A")]);
    expect(await unnamed.apply(id)).toBe("Google Drive answered without the file's name");
    expect(unnamed.journal.get(id)?.state).toBe("pending");
    expect(unnamed.api.renameFile).not.toHaveBeenCalled();
  });

  it("asks the access level and the grant again when a rename is approved", async () => {
    let readOnly = readOnlyRefusal(ACCOUNT);
    let fixed = harness();
    let failed = await fixed.submit(renameF());
    fixed.refuse(readOnly);
    expect(await fixed.apply(failed)).toBe(readOnly);
    expect(fixed.journal.get(failed)).toEqual(failedUnsent(renameF(), readOnly));
    expect(fixed.api.getScopeNodes).not.toHaveBeenCalled();

    let { api, journal, attempts, names, submit, apply, refuse } = harness();
    let id = await submit(renameF());
    refuse(WRITES_GRANT_MISSING);
    expect(await apply(id)).toBe(WRITES_GRANT_MISSING);
    expect(journal.get(id)?.state).toBe("pending");
    expect(api.getScopeNodes).not.toHaveBeenCalled();
    expect(attempts.size).toBe(0);
    refuse(undefined);
    expect(await apply(id)).toBeNull();
    expect(names.F).toBe("Budget 2027");
  });
});

describe("Drive rename sends and their markers", () => {
  it("finds an earlier send's rename instead of renaming again", async () => {
    // Google answers 400 invalidParameter for a response mask it does not accept, after the rename.
    for (let lost of [unconfirmed(), new DriveApiRequestError(400, "invalidParameter")]) {
      let { api, journal, attempts, names, submit, apply, renameThenAnswer } = harness();
      renameThenAnswer(lost);
      let id = await submit(renameF());
      expect(await apply(id), lost.reason).toBe(UNCONFIRMED_RENAME);
      expect(journal.get(id)?.state, lost.reason).toBe("pending");
      let marker = attempts.get(id);
      expect(marker, lost.reason).toEqual({ at: expect.any(Number) });

      expect(await apply(id), lost.reason).toBeNull();
      expect(api.renameFile, lost.reason).toHaveBeenCalledTimes(1);
      expect(names.F, lost.reason).toBe("Budget 2027");
      expect(journal.get(id), lost.reason).toBeUndefined();
      expect(attempts.get(id), lost.reason).toBe(marker);
    }
  });

  it("sends again once a look finds the old name, however often", async () => {
    let { api, journal, names, submit, apply } = harness();
    api.renameFile.mockRejectedValue(unconfirmed());
    let id = await submit(renameF());
    for (let send = 1; send <= 3; send++) {
      expect(await apply(id), `send ${send}`).toBe(UNCONFIRMED_RENAME);
      expect(api.renameFile, `send ${send}`).toHaveBeenCalledTimes(send);
      // The first approval checks; each later one looks, then checks.
      expect(api.getScopeNodes, `send ${send}`).toHaveBeenCalledTimes(2 * send - 1);
      expect(journal.get(id)?.state, `send ${send}`).toBe("pending");
    }
    expect(names.F).toBe("Budget 2026");
  });

  it("ends as of unknown outcome when a look finds another name, or cannot see the file", async () => {
    let again = harness();
    again.api.renameFile.mockRejectedValueOnce(unconfirmed());
    let renamed = await again.submit(renameF());
    expect(await again.apply(renamed)).toBe(UNCONFIRMED_RENAME);
    again.names.F = "Budget (old)";
    expect(await again.apply(renamed)).toBe(RENAMED_AGAIN);
    expect(again.journal.get(renamed)).toMatchObject({ state: "failed", outcome: "unknown" });
    expect(again.attempts.has(renamed)).toBe(true);
    expect(again.api.renameFile).toHaveBeenCalledTimes(1);

    let gone = harness(AT_R);
    gone.api.renameFile.mockRejectedValueOnce(unconfirmed());
    let id = await gone.submit(renameFFromA());
    expect(await gone.apply(id)).toBe(UNCONFIRMED_RENAME);
    gone.nodes.F = file("F", "R");
    expect(await gone.apply(id)).toBe(NO_LONGER_SHOWN);
    expect(gone.journal.get(id)).toMatchObject({ state: "failed", outcome: "unknown" });
    expect(gone.api.renameFile).toHaveBeenCalledTimes(1);
  });

  it("leaves the outcome open when Google answers a rename with another name", async () => {
    let { api, journal, attempts, submit, apply } = harness();
    api.renameFile.mockResolvedValueOnce({ id: "F", name: "Budget 2026" });
    let id = await submit(renameF());
    expect(await apply(id)).toBe(UNCONFIRMED_RENAME);
    expect(journal.get(id)?.state).toBe("pending");
    expect(attempts.has(id)).toBe(true);
  });

  it("keeps a rename pending when Google stops accepting the token, or limits the rate", async () => {
    for (let [error, message] of [
      [new DriveApiRequestError(401), CREDENTIALS_NOT_ACCEPTED],
      [new DriveApiRequestError(429, "rateLimitExceeded"), RATE_LIMITED],
    ] as const) {
      let { api, journal, attempts, names, submit, apply, renameThenAnswer } = harness();
      // Were the send to have renamed the file all the same, the look finds it.
      renameThenAnswer(error);
      let id = await submit(renameF());
      expect(await apply(id), message).toBe(message);
      expect(journal.get(id)?.state, message).toBe("pending");
      expect(attempts.get(id), message).toEqual({ at: expect.any(Number) });
      expect(await apply(id), message).toBeNull();
      expect(api.renameFile, message).toHaveBeenCalledTimes(1);
      expect(names.F, message).toBe("Budget 2027");
    }
  });

  it("keeps a rename pending, with its marker, when the look cannot read for a missing scope", async () => {
    let unreadable: [string, (api: ReturnType<typeof harness>["api"]) => void][] = [
      ["the part refused", api => { api.getScopeNodes.mockResolvedValueOnce([undefined]); }],
      ["the read refused", api => { api.getScopeNodes.mockRejectedValueOnce(missingScope()); }],
    ];
    for (let [what, refuseRead] of unreadable) {
      let { api, journal, attempts, names, submit, apply, refuse, renameThenAnswer } = harness();
      renameThenAnswer(unconfirmed());
      let id = await submit(renameF());
      expect(await apply(id), what).toBe(UNCONFIRMED_RENAME);
      let marker = attempts.get(id);

      refuseRead(api);
      refuse(WRITES_GRANT_MISSING);
      expect(await apply(id), what).toBe(WRITES_GRANT_MISSING);
      expect(journal.get(id)?.state, what).toBe("pending");
      expect(attempts.get(id), what).toBe(marker);

      refuse(undefined);
      expect(await apply(id), what).toBeNull();
      expect(api.renameFile, what).toHaveBeenCalledTimes(1);
      expect(names.F, what).toBe("Budget 2027");
    }
  });

  it.each([
    [400, "badRequest", "Google Drive refused that name as invalid."],
    [400, "invalid", "Google Drive refused that name as invalid."],
    [403, "insufficientFilePermissions", CANNOT_RENAME],
    [403, "fileNeverWritable", "Google Drive does not let that be renamed."],
    [404, "notFound", "Google Drive no longer shows that file to the connected account."],
    [403, "domainPolicy",
      "Your organization's administrator does not allow this app to use Google Drive."],
    [403, "somethingNew", "Google Drive refused this rename."],
  ])("turns Google's refusal into words and keeps its code: %i %s", async (status, reason, message) => {
    let { api, journal, attempts, names, submit, apply } = harness();
    api.renameFile.mockRejectedValueOnce(new DriveApiRequestError(status, reason));
    let id = await submit(renameF());
    expect(await apply(id)).toBe(`${message} [http=${status} reason=${reason}]`);
    expect(journal.get(id)?.state).toBe("failed");
    // A refusal changed nothing, so no send of it is in doubt.
    expect(attempts.has(id)).toBe(false);
    expect(names.F).toBe("Budget 2026");
  });

  it("says when the Drive API is off", async () => {
    let { api, submit, apply } = harness();
    api.renameFile.mockRejectedValueOnce(new DriveApiDisabledError("disabled"));
    expect(await apply(await submit(renameF()))).toBe(
      "The Google Drive API is not enabled for this deployment's Google project. " +
      "[http=403 reason=accessNotConfigured]");
  });
});

describe("Drive renames awaiting a decision", () => {
  it("finds a queued rename of the file asked about, and of nothing else", () => {
    let rename: QueuedWrite = { id: 3, action: { kind: "renameFile", payload: renameA() } };
    expect(hasPendingRename("A", [rename])).toBe(true);
    expect(hasPendingRename("R", [rename])).toBe(false);
    expect(hasPendingRename("F", [rename])).toBe(false);
    expect(hasPendingRename("A", [])).toBe(false);
    let others: QueuedWrite[] = [
      { id: 1, action: { kind: "moveFile", payload: { fileId: "A" } } },
      { id: 2, action: { kind: "createPermission", payload: { fileId: "A" } } },
      { id: 4, action: { kind: "toString", payload: { fileId: "A" } } },
    ];
    expect(hasPendingRename("A", others)).toBe(false);
    expect(RENAME_PENDING).toBe(
      "That file already has a rename waiting for approval. To give it another name instead, " +
      "have the user reject that rename first.");
  });
});

describe("Drive rename logs", () => {
  it("logs IDs and outcomes only, never a name", async () => {
    let spies = (["debug", "info", "warn", "error"] as const)
      .map(level => vi.spyOn(console, level).mockImplementation(() => {}));
    let payload = renameF({ fromName: "Secret plan", toName: "Secret plan v2" });
    let named = async () => {
      let made = harness();
      made.names.F = "Secret plan";
      return { ...made, id: await made.submit(payload) };
    };

    let applied = await named();
    expect(await applied.apply(applied.id)).toBeNull();
    let lost = await named();
    lost.renameThenAnswer(unconfirmed());
    expect(await lost.apply(lost.id)).toBe(UNCONFIRMED_RENAME);
    expect(await lost.apply(lost.id)).toBeNull();
    let refused = await named();
    refused.api.renameFile.mockRejectedValueOnce(
      new DriveApiRequestError(403, "insufficientFilePermissions"));
    expect(await refused.apply(refused.id)).toMatch(/^The connected account can no longer rename/);

    let lines = spies.flatMap(spy => spy.mock.calls.map(([line]): Record<string, unknown> => {
      let { errorStack: _stack, ...fields } = line as Record<string, unknown>;
      return fields;
    }));
    let own = lines.filter(line => line.component === "gatekeeper.google.drive.renames");
    // Grouped by level: the info lines, then the warnings.
    expect(own.map(line => [line.event, line.outcome])).toEqual([
      ["drive.renames.applied", "applied"],
      ["drive.renames.reconciled", "found"],
      ["drive.renames.send.failed", "unknown"],
      ["drive.renames.send.failed", "absent"],
    ]);
    for (let line of own) {
      expect(line).toMatchObject({ vendorId: "google", actionKind: "renameFile", fileId: "F" });
    }
    expect(JSON.stringify(lines)).not.toContain("Secret plan");
  });
});
