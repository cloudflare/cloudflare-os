import { ActionJournal, defineActions } from "@gadgets/gatekeeper-kit/actions";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMENT_WRITE_MAX_MS, COPY_TOKEN_PROPERTY, CONVERTED_FROM_PROPERTY, DriveApi,
  DriveApiRequestError, FOLDER_MIME_TYPE, SOURCE_MODIFIED_PROPERTY, type DriveScopeNode,
} from "../src/drive-api";
import {
  DRIVE_COPIES, DRIVE_COPY_DEFINITIONS, pendingActionId, pendingCopiesInto, pendingCopy,
  planCopy, waitingNativeCopy, type DriveCopiesHost, type DriveCopyAction, type DriveCopyActions,
} from "../src/drive-copies";
import {
  GOOGLE_DOC_MIME_TYPE, GOOGLE_SHEET_MIME_TYPE, type DriveBindingScope,
} from "../src/drive-session";
import type { QueuedWrite, WriteAttempt } from "../src/drive-writes";
import { FakeKv } from "./fake-kv";

const ACCOUNT: DriveBindingScope = { kind: "account" };
const AT_R: DriveBindingScope = { kind: "folder", folderId: "R" };
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const OUT_OF_SCOPE = "That file is no longer in this connection's scope.";
const FILE_IN_TRASH = "That file is in the trash, so it was not copied.";
const DESTINATION_IN_TRASH = "That folder is in the trash, so nothing was copied into it.";
const CANNOT_COPY = "The connected account can no longer copy that file into that folder.";
const UNCONFIRMED_COPY =
  "Google Drive did not confirm whether this copy was made, and it may have been. Approving it " +
  "again first checks for it, so it is not made twice; rejecting it leaves any copy that was made.";
const UNCONFIRMED_NATIVE_COPY =
  "Google Drive did not confirm whether this copy was made, and it may have been: Google Drive " +
  "can take a while to show a new file. It won't be sent again. Approving it again looks for the " +
  "copy once more; rejecting it leaves any copy that was made.";
const TAKES_SHARING =
  "The copy takes the sharing of the folder it goes into: everyone with access to that folder " +
  "can open it.";
const DIFFERENT_TYPE = "Google Drive made a copy of a different type than was asked for";

/** A live folder the account can list and add to, as a scope proof reads it. */
function folder(id: string, parent: string): DriveScopeNode {
  return {
    id, mimeType: FOLDER_MIME_TYPE, parents: [parent], trashed: false, canListChildren: true,
    canAddChildren: true,
  };
}

/** A live file the account can copy, as a scope proof reads it. */
function file(id: string, parent: string, mimeType = "application/pdf"): DriveScopeNode {
  return { id, mimeType, parents: [parent], trashed: false, canCopy: true };
}

/** Folder `R` holds folder `A`, which holds folder `B` and file `F`; `X` is elsewhere. */
type Tree = Record<"R" | "A" | "B" | "F" | "X", DriveScopeNode> &
  Record<string, DriveScopeNode | undefined>;

function tree(): Tree {
  return {
    R: folder("R", "above"), A: folder("A", "R"), B: folder("B", "A"), F: file("F", "A"),
    X: folder("X", "elsewhere"),
  };
}

/** An ordinary copy of `F` into `B`, as an account binding queues it. */
function intoB(overrides: Partial<DriveCopyActions["copyFile"]> = {}): DriveCopyActions["copyFile"] {
  return {
    fileId: "F", fileName: "Budget.pdf", name: "Copy of Budget.pdf", mimeType: "application/pdf",
    toFolderId: "B", toName: "Archive", queuedAt: "2026-05-01T10:00:00.000Z", copyId: "C",
    size: 1234, ...overrides,
  };
}

/** A conversion of `F`, a .docx file, into a Google Doc in `B`. */
function nativeIntoB(
  overrides: Partial<DriveCopyActions["copyNative"]> = {},
): DriveCopyActions["copyNative"] {
  return {
    fileId: "F", fileName: "Plan.docx", name: "Plan", mimeType: GOOGLE_DOC_MIME_TYPE,
    toFolderId: "B", toName: "Archive", queuedAt: "2026-05-01T10:00:00.000Z", token: "t0k3n",
    convertTo: "document", ...overrides,
  };
}

/** Drive's answer to a send whose outcome it leaves open. */
const unconfirmed = () => new DriveApiRequestError(503, "backendError");

const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected call");
};

const COPY_ACTIONS = defineActions<DriveCopiesHost, DriveCopyActions>(
  DRIVE_COPY_DEFINITIONS, { fence: "none", vendorId: "google" });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * The copy set bound over an in-memory journal, with a host whose batch read answers from a tree
 * a test can change, and whose copy adds to it.
 */
function harness(scope: DriveBindingScope = ACCOUNT) {
  let nodes = tree();
  let attempts = new Map<number, WriteAttempt>();
  /** What Drive stops showing the account. */
  let hidden = new Set<string>();
  let made = new Map<number, string>();
  let described: ActionDescription | undefined;
  let nextNative = 1;
  /** What Drive does with a copy: a new file in the folder named. */
  let copy: DriveApi["copyFile"] = async (fileId, { id, parents, mimeType }) => {
    let source = nodes[fileId];
    if (!source) throw new DriveApiRequestError(404, "notFound");
    let copyId = id ?? `N${nextNative++}`;
    if (nodes[copyId]) return undefined;
    nodes[copyId] = file(copyId, parents[0], mimeType ?? source.mimeType);
    return { id: copyId, mimeType: nodes[copyId].mimeType };
  };
  let api = {
    getScopeNodes: vi.fn<DriveApi["getScopeNodes"]>(async ids =>
      ids.map(id => nodes[id] && !hidden.has(id) ? structuredClone(nodes[id]) : undefined)),
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
    copyFile: vi.fn<DriveApi["copyFile"]>(copy),
    findCopy: vi.fn<DriveApi["findCopy"]>(async () => undefined),
    getConversionSource: vi.fn<DriveApi["getConversionSource"]>(async id =>
      ({ id, name: "Plan.docx", mimeType: DOCX, size: "1000" })),
    getMaxImportSize: vi.fn<DriveApi["getMaxImportSize"]>(async () => 10 * 1024 * 1024),
  };
  let host: DriveCopiesHost = {
    api,
    docs: {
      getDocumentWithSuggestions: unexpected, getRevisionId: unexpected, insertComment: unexpected,
      suggest: unexpected, replyToSuggestion: unexpected,
    },
    scope: () => scope,
    writeRefusal: async () => undefined,
    attempts: {
      get: id => attempts.get(id),
      put: (id, attempt) => { attempts.set(id, attempt); },
      delete: id => { attempts.delete(id); },
    },
    madeCopies: { put: (id, fileId) => { made.set(id, fileId); } },
  };
  let journal = new ActionJournal<DriveCopyAction>(new FakeKv(), { namespace: "drive" });
  let actions = COPY_ACTIONS.bind(journal, host);
  let queue = {
    submitAction: async (_id: number, description: ActionDescription) => { described = description; },
  };
  let submit = <K extends keyof DriveCopyActions>(kind: K, payload: DriveCopyActions[K]) =>
    actions.submit(queue, kind, payload);
  return {
    api, host, journal, actions, attempts, made, nodes, hidden, submit, copy,
    async card<K extends keyof DriveCopyActions>(
      kind: K, payload: DriveCopyActions[K],
    ): Promise<ActionDescription> {
      await submit(kind, payload);
      if (!described) throw new Error("nothing was described");
      return described;
    },
    /** Applies an action, answering `null` when it applied and the failure's message otherwise. */
    apply: (id: number): Promise<string | null> =>
      actions.apply(id).then(() => null, (error: Error) => error.message),
    /** Makes the next send make the copy and then answer `error`. */
    copyThenAnswer(error: Error): void {
      api.copyFile.mockImplementationOnce(async (...args) => {
        await copy(...args);
        throw error;
      });
    },
  };
}

describe("Drive copy verdict and approval card", () => {
  it("declares one auto-approvable kind; an ordinary copy goes on, a native one awaits", async () => {
    let ordinary = harness();
    let card = await ordinary.card("copyFile", intoB());
    expect(card).toMatchObject({
      autoApprovable: true, actionKind: DRIVE_COPIES, implementsRevert: false,
    });
    // An ordinary copy is shown while it waits, so the call does not wait for its decision.
    expect(card.awaitDecision).toBeUndefined();
    expect(ordinary.actions.autoApprovableKinds()).toEqual([DRIVE_COPIES]);
    expect(await harness().card("copyNative", nativeIntoB())).toMatchObject({
      autoApprovable: true, actionKind: DRIVE_COPIES, awaitDecision: true,
    });
  });

  it("names the file, the folder, the copy and what the copy can be opened by", async () => {
    let card = await harness().card("copyFile", intoB());
    expect(card.title).toBe("Copy a Google Drive file");
    expect(card.description).toBe(
      "Copy Google Drive file `F` into folder `B`, as the connected account.\n\n" + TAKES_SHARING);
    expect(card.fields).toEqual([
      { label: "File", kind: "inline", value: "F" },
      { label: "File name", kind: "inline", value: "Budget.pdf" },
      { label: "Copy name", kind: "inline", value: "Copy of Budget.pdf" },
      { label: "To folder", kind: "inline", value: "B" },
      { label: "To folder name", kind: "inline", value: "Archive" },
    ]);
    expect(card.descriptionIsComplete).toBe(true);

    let { toName: _toName, ...top } = nativeIntoB({ toMyDrive: true });
    let converted = await harness().card("copyNative", top);
    expect(converted.description.split("\n\n")).toEqual([
      "Copy Google Drive file `F` into folder `B`, as the connected account.",
      "The copy is converted to a Google Doc.",
      "The folder it goes into is the top level of the connected account's My Drive.",
      TAKES_SHARING,
    ]);
    expect(converted.fields).toEqual([
      { label: "File", kind: "inline", value: "F" },
      { label: "File name", kind: "inline", value: "Plan.docx" },
      { label: "Copy name", kind: "inline", value: "Plan" },
      { label: "To folder", kind: "inline", value: "B" },
      { label: "Converted to", kind: "inline", value: "Google Doc" },
    ]);
  });
});

describe("Drive copy sends", () => {
  it("makes an ordinary copy once, under the ID reserved for it", async () => {
    let { api, journal, nodes, submit, apply } = harness();
    let id = await submit("copyFile", intoB());
    expect(await apply(id)).toBeNull();
    expect(api.copyFile).toHaveBeenCalledTimes(1);
    expect(api.copyFile).toHaveBeenCalledWith(
      "F", { id: "C", name: "Copy of Budget.pdf", parents: ["B"] });
    expect(nodes.C?.parents).toEqual(["B"]);
    expect(journal.get(id)).toBeUndefined();
  });

  it("finds an ordinary copy an unconfirmed send made instead of sending again", async () => {
    let { api, journal, nodes, submit, apply, copyThenAnswer } = harness();
    copyThenAnswer(unconfirmed());
    let id = await submit("copyFile", intoB());
    expect(await apply(id)).toBe(UNCONFIRMED_COPY);
    expect(journal.get(id)?.state).toBe("pending");
    expect(await apply(id)).toBeNull();
    expect(api.copyFile).toHaveBeenCalledTimes(1);
    expect(api.getScopeNodes).toHaveBeenCalledWith(["C"]);
    expect(nodes.C?.parents).toEqual(["B"]);
  });

  it("sends an unconfirmed ordinary copy again under the same ID when none was made", async () => {
    let { api, nodes, submit, apply } = harness();
    api.copyFile.mockRejectedValueOnce(unconfirmed());
    let id = await submit("copyFile", intoB());
    expect(await apply(id)).toBe(UNCONFIRMED_COPY);
    expect(await apply(id)).toBeNull();
    expect(api.copyFile).toHaveBeenCalledTimes(2);
    expect(api.copyFile.mock.calls[1]?.[1]).toMatchObject({ id: "C" });
    expect(nodes.C?.parents).toEqual(["B"]);
  });

  it("counts a reserved ID Drive refuses as used as the copy made", async () => {
    let { api, submit, apply } = harness();
    api.copyFile.mockResolvedValueOnce(undefined);
    expect(await apply(await submit("copyFile", intoB()))).toBeNull();
    expect(api.copyFile).toHaveBeenCalledTimes(1);
  });

  it("makes a native copy with its token, clearing the markers it would keep, and records the file it made", async () => {
    let { api, made, nodes, submit, apply } = harness();
    nodes.F = file("F", "A", DOCX);
    let id = await submit("copyNative", nativeIntoB());
    expect(await apply(id)).toBeNull();
    // Drive patches a copy's app properties over its file's: a conversion's markers would offer
    // the copy for reuse as that conversion.
    expect(api.copyFile).toHaveBeenCalledWith("F", {
      name: "Plan", parents: ["B"], mimeType: GOOGLE_DOC_MIME_TYPE,
      appProperties: {
        [COPY_TOKEN_PROPERTY]: "t0k3n", [CONVERTED_FROM_PROPERTY]: null,
        [SOURCE_MODIFIED_PROPERTY]: null,
      },
    });
    expect(made.get(id)).toBe("N1");
    expect(nodes.N1?.mimeType).toBe(GOOGLE_DOC_MIME_TYPE);

    // A copy of a native file is not converted, so it names no type.
    let plain = harness();
    plain.nodes.F = file("F", "A", GOOGLE_SHEET_MIME_TYPE);
    let { convertTo: _convertTo, ...sheet } = nativeIntoB({ mimeType: GOOGLE_SHEET_MIME_TYPE });
    expect(await plain.apply(await plain.submit("copyNative", sheet))).toBeNull();
    expect(plain.api.copyFile.mock.calls[0]?.[1]).not.toHaveProperty("mimeType");
    expect(plain.api.getConversionSource).not.toHaveBeenCalled();
  });

  it("finds a native copy by its token in its folder's corpus, and never sends one twice", async () => {
    let found = harness();
    found.copyThenAnswer(unconfirmed());
    let id = await found.submit("copyNative", nativeIntoB({ driveId: "D1" }));
    expect(await found.apply(id)).toBe(UNCONFIRMED_NATIVE_COPY);
    found.api.findCopy.mockResolvedValue({ id: "N1", mimeType: GOOGLE_DOC_MIME_TYPE });
    expect(await found.apply(id)).toBeNull();
    expect(found.api.findCopy).toHaveBeenCalledWith("t0k3n", { kind: "drive", driveId: "D1" });
    expect(found.api.copyFile).toHaveBeenCalledTimes(1);
    expect(found.made.get(id)).toBe("N1");

    // Drive's search lags, so a look that finds nothing proves nothing.
    let lost = harness();
    lost.api.copyFile.mockRejectedValueOnce(unconfirmed());
    let again = await lost.submit("copyNative", nativeIntoB());
    expect(await lost.apply(again)).toBe(UNCONFIRMED_NATIVE_COPY);
    expect(await lost.apply(again)).toBe(UNCONFIRMED_NATIVE_COPY);
    expect(lost.api.copyFile).toHaveBeenCalledTimes(1);
    expect(lost.journal.get(again)?.state).toBe("pending");
    expect(lost.made.size).toBe(0);
    expect(lost.api.findCopy).toHaveBeenCalledWith("t0k3n", { kind: "user" });
  });

  it("fails a native copy Google Drive made of another type than asked for, recording nothing", async () => {
    let sent = harness();
    sent.api.copyFile.mockResolvedValueOnce({ id: "N1", mimeType: DOCX });
    let id = await sent.submit("copyNative", nativeIntoB());
    expect(await sent.apply(id)).toBe(DIFFERENT_TYPE);
    expect(sent.journal.get(id)?.state).toBe("failed");
    expect(sent.made.size).toBe(0);

    // The same when a look finds it after a lost answer.
    let found = harness();
    found.api.copyFile.mockRejectedValueOnce(unconfirmed());
    let again = await found.submit("copyNative", nativeIntoB());
    expect(await found.apply(again)).toBe(UNCONFIRMED_NATIVE_COPY);
    found.api.findCopy.mockResolvedValue({ id: "N1", mimeType: DOCX });
    expect(await found.apply(again)).toBe(DIFFERENT_TYPE);
    expect(found.journal.get(again)?.state).toBe("failed");
    expect(found.made.size).toBe(0);
  });

  it("gives up on a native copy's send at Drive's write deadline, then looks for it rather than sending again", async () => {
    let { api, attempts, journal, submit, apply } = harness();
    // The deadline passes when the test says.
    let deadline = new AbortController();
    let timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    // Drive takes the request and never answers it, until the request is aborted.
    let sent = 0;
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      sent++;
      let { promise, reject } = Promise.withResolvers<never>();
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      return promise;
    });
    let drive = new DriveApi(async () => "token");
    api.copyFile.mockImplementation((fileId, copy) => drive.copyFile(fileId, copy));
    let id = await submit("copyNative", nativeIntoB());
    let outcome: string | null | undefined;
    void apply(id).then(message => { outcome = message; });
    await vi.waitFor(() => expect(sent).toBe(1));
    expect(timeout.mock.calls).toEqual([[COMMENT_WRITE_MAX_MS / 3]]);
    deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
    await vi.waitFor(() => expect(outcome).toBe(UNCONFIRMED_NATIVE_COPY));
    expect(attempts.has(id)).toBe(true);
    expect(journal.get(id)?.state).toBe("pending");

    expect(await apply(id)).toBe(UNCONFIRMED_NATIVE_COPY);
    expect(api.findCopy).toHaveBeenCalledTimes(1);
    expect(api.copyFile).toHaveBeenCalledTimes(1);
  });
});

describe("Drive copy checks at apply", () => {
  it("refuses a file or a folder that can no longer be copied, sending nothing", async () => {
    let cases: [string, (nodes: Tree, hidden: Set<string>) => void, string][] = [
      ["file in the trash", nodes => { nodes.F = { ...nodes.F, trashed: true }; }, FILE_IN_TRASH],
      ["folder in the trash", nodes => { nodes.B = { ...nodes.B, trashed: true }; },
        DESTINATION_IN_TRASH],
      ["copying turned off", nodes => { nodes.F = { ...nodes.F, canCopy: false }; }, CANNOT_COPY],
      ["folder closed", nodes => { nodes.B = { ...nodes.B, canAddChildren: false }; }, CANNOT_COPY],
      ["file gone", (_nodes, hidden) => { hidden.add("F"); }, OUT_OF_SCOPE],
    ];
    for (let [what, change, message] of cases) {
      let { api, journal, nodes, hidden, submit, apply } = harness();
      let id = await submit("copyFile", intoB());
      change(nodes, hidden);
      expect(await apply(id), what).toBe(message);
      expect(journal.get(id)?.state, what).toBe("failed");
      expect(api.copyFile, what).not.toHaveBeenCalled();
    }
  });

  it("refuses a conversion larger than Google Drive converts", async () => {
    let { api, submit, apply } = harness();
    api.getConversionSource.mockResolvedValue(
      { id: "F", name: "Plan.docx", mimeType: DOCX, size: String(20 * 1024 * 1024) });
    expect(await apply(await submit("copyNative", nativeIntoB()))).toBe(
      "That file is 20 MB, larger than the 10 MB Google Drive converts into this format.");
    expect(api.getMaxImportSize).toHaveBeenCalledWith(GOOGLE_DOC_MIME_TYPE);
    expect(api.copyFile).not.toHaveBeenCalled();
  });

  it("proves a conversion's folder after Drive's conversion reads, sending nothing once it left", async () => {
    for (let read of ["getConversionSource", "getMaxImportSize"]) {
      let { api, journal, nodes, submit, apply } = harness(AT_R);
      let id = await submit("copyNative", nativeIntoB({ folderIds: ["R", "A"] }));
      // The folder leaves the bound tree while Drive answers.
      let leave = () => { nodes.B = folder("B", "X"); };
      if (read === "getConversionSource") {
        api.getConversionSource.mockImplementationOnce(async fileId => {
          leave();
          return { id: fileId, name: "Plan.docx", mimeType: DOCX, size: "1000" };
        });
      } else {
        api.getMaxImportSize.mockImplementationOnce(async () => {
          leave();
          return 10 * 1024 * 1024;
        });
      }
      expect(await apply(id), read).toBe(OUT_OF_SCOPE);
      expect(journal.get(id)?.state, read).toBe("failed");
      expect(api.copyFile, read).not.toHaveBeenCalled();
    }
  });

  it("refuses a conversion whose file is no longer of the Office type queued", async () => {
    let { api, journal, submit, apply } = harness();
    let id = await submit("copyNative", nativeIntoB());
    // Drive changes a file's type only with a new revision, which a file of another type can be.
    api.getConversionSource.mockResolvedValue(
      { id: "F", name: "Plan.docx", mimeType: "application/pdf", size: "1000" });
    expect(await apply(id)).toBe(
      "That file is no longer a .docx, .doc, .odt or .rtf file, so it was not converted.");
    expect(journal.get(id)?.state).toBe("failed");
    expect(api.copyFile).not.toHaveBeenCalled();
  });

  it("proves a folder binding's copy along its saved path, into a folder it reaches", async () => {
    let fromA = { folderIds: ["R", "A"] };
    for (let [what, toFolderId] of [["the positioned folder", "A"], ["a child folder", "B"],
      ["the folder above", "R"]]) {
      let { submit, apply, nodes } = harness(AT_R);
      expect(await apply(await submit("copyFile", intoB({ ...fromA, toFolderId }))), what).toBeNull();
      expect(nodes.C?.parents, what).toEqual([toFolderId]);
    }
    let elsewhere = harness(AT_R);
    let id = await elsewhere.submit("copyFile", intoB({ ...fromA, toFolderId: "X" }));
    expect(await elsewhere.apply(id)).toBe(OUT_OF_SCOPE);
    expect(elsewhere.api.copyFile).not.toHaveBeenCalled();

    let moved = harness(AT_R);
    let away = await moved.submit("copyFile", intoB(fromA));
    moved.nodes.F = file("F", "B");
    expect(await moved.apply(away)).toBe(OUT_OF_SCOPE);
  });
});

describe("planCopy", () => {
  it("copies a file as it is under its default name, or the name given", () => {
    expect(planCopy({ name: "Budget.pdf", mimeType: "application/pdf" }, {}))
      .toEqual({ kind: "copyFile", mimeType: "application/pdf", name: "Copy of Budget.pdf" });
    expect(planCopy({ name: "Notes", mimeType: GOOGLE_DOC_MIME_TYPE }, { name: "Mine" }))
      .toEqual({ kind: "copyNative", mimeType: GOOGLE_DOC_MIME_TYPE, name: "Mine" });
  });

  it("converts an Office file, named without its extension", () => {
    expect(planCopy({ name: "Plan.docx", mimeType: DOCX }, { convertTo: "document" })).toEqual({
      kind: "copyNative", mimeType: GOOGLE_DOC_MIME_TYPE, name: "Plan", convertTo: "document",
    });
  });

  it("refuses what it cannot copy or convert", () => {
    expect(() => planCopy({ name: "x", mimeType: "application/pdf" }, { name: " " }))
      .toThrow("name is empty.");
    expect(() => planCopy({ name: "x.pdf", mimeType: "application/pdf" }, { convertTo: "document" }))
      .toThrow("Only a .docx, .doc, .odt or .rtf file converts to a Google Doc.");
    expect(() => planCopy({ name: "x", mimeType: GOOGLE_DOC_MIME_TYPE }, { convertTo: "document" }))
      .toThrow("That file is already a Google Doc.");
    expect(() => planCopy(
      { name: "x", mimeType: DOCX }, { convertTo: "pdf" as unknown as "document" }))
      .toThrow('convertTo is "document", "spreadsheet" or "presentation".');
    expect(() => planCopy({ name: "x", mimeType: "application/vnd.google-apps.form" }, {}))
      .toThrow("only Google Docs, Sheets and Slides files can be copied here.");
  });
});

describe("Drive copies while they wait", () => {
  let entry = (id: number, action: DriveCopyAction): QueuedWrite =>
    ({ id, action, state: "pending" }) as QueuedWrite;
  let pending = [
    entry(1, { kind: "copyFile", payload: intoB() }),
    entry(2, { kind: "copyNative", payload: nativeIntoB() }),
    entry(3, { kind: "copyFile", payload: intoB({ copyId: "D", toFolderId: "X" }) }),
  ];

  it("shows an ordinary copy by its reserved ID, reporting the file it is a copy of", () => {
    expect(pendingCopy("C", pending)).toEqual({
      entry: {
        id: "C", name: "Copy of Budget.pdf", mimeType: "application/pdf", isFolder: false,
        modifiedTime: new Date("2026-05-01T10:00:00.000Z"), size: 1234, parentId: "B",
        pending: true,
      },
      sourceId: "F",
    });
    expect(pendingCopy("F", pending)).toBeUndefined();
    expect(pendingCopiesInto("B", pending).map(({ entry }) => entry.id)).toEqual(["C"]);
    expect(pendingCopiesInto("A", pending)).toEqual([]);
  });

  it("shows a native copy only by its pending ID", () => {
    expect(waitingNativeCopy(2, pending)?.entry).toMatchObject(
      { id: "pending:2", mimeType: GOOGLE_DOC_MIME_TYPE, pending: true });
    expect(waitingNativeCopy(1, pending)).toBeUndefined();
    expect(pendingActionId("pending:2")).toBe(2);
    expect(pendingActionId("pending:x")).toBeUndefined();
    expect(pendingActionId("C")).toBeUndefined();
  });
});
