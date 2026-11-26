import { ActionJournal, defineActions } from "@gadgets/gatekeeper-kit/actions";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPROVAL_READ_MAX_MS, COMMENT_WRITE_MAX_MS, COPY_TOKEN_PROPERTY, CONVERTED_FROM_PROPERTY,
  DriveApi, DriveApiRequestError, FOLDER_MIME_TYPE, SAVED_PROPERTY, SOURCE_MODIFIED_PROPERTY,
  UPLOAD_TOKEN_PROPERTY, type DriveScopeNode,
} from "../src/drive-api";
import { pendingFile, pendingFilesInto, waitingFile } from "../src/drive-actions";
import {
  DRIVE_COPIES, DRIVE_COPY_DEFINITIONS, DRIVE_EXPORT_COPIES, madeFiles, pendingActionId, planCopy,
  type DriveCopiesHost, type DriveCopyAction, type DriveCopyActions,
} from "../src/drive-copies";
import { FILE_READ_IDLE_MS } from "../src/drive-file-read";
import {
  GOOGLE_DOC_MIME_TYPE, GOOGLE_SHEET_MIME_TYPE, type DriveBindingScope,
} from "../src/drive-session";
import { CREDENTIALS_NOT_ACCEPTED, type QueuedWrite, type WriteAttempt } from "../src/drive-writes";
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
const DRIVE_DID_NOT_ANSWER =
  "Google Drive did not answer in time, so nothing was copied. Approving it again tries once more.";

/** A live folder the account can list and add to, as a scope proof reads it. */
function folder(id: string, parent: string): DriveScopeNode {
  return {
    id, mimeType: FOLDER_MIME_TYPE, parents: [parent], trashed: false, canListChildren: true,
    canAddChildren: true,
  };
}

/** A live file the account can copy, as a scope proof reads it. */
function file(id: string, parent: string, mimeType = "application/pdf"): DriveScopeNode {
  return { id, mimeType, parents: [parent], trashed: false, canCopy: true, canDownload: true };
}

/** Folder `R` holds folder `A`, which holds folder `B` and file `F`, a .docx file; `X` is elsewhere. */
type Tree = Record<"R" | "A" | "B" | "F" | "X", DriveScopeNode> &
  Record<string, DriveScopeNode | undefined>;

function tree(): Tree {
  return {
    R: folder("R", "above"), A: folder("A", "R"), B: folder("B", "A"), F: file("F", "A", DOCX),
    X: folder("X", "elsewhere"),
  };
}

/** An ordinary copy of `F` into `B`, as an account binding queues it. */
function intoB(overrides: Partial<DriveCopyActions["copyFile"]> = {}): DriveCopyActions["copyFile"] {
  return {
    fileId: "F", fileName: "Budget.docx", name: "Copy of Budget.docx", mimeType: DOCX,
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

/** An export of `F`, a Google Doc, to PDF, uploaded into `B` under the ID reserved for it. */
function exportIntoB(
  overrides: Partial<DriveCopyActions["exportCopy"]> = {},
): DriveCopyActions["exportCopy"] {
  return {
    fileId: "F", fileName: "Notes", name: "Notes.pdf", mimeType: "application/pdf",
    toFolderId: "B", toName: "Archive", queuedAt: "2026-05-01T10:00:00.000Z", copyId: "E",
    format: "pdf", ...overrides,
  };
}

/** The text of a stream, read to its end. */
async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

/** Drive's answer to a send whose outcome it leaves open. */
const unconfirmed = () => new DriveApiRequestError(503, "backendError");

const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected call");
};

/** `AbortSignal.timeout()`'s deadlines, which all pass when the test says. */
function deadlines() {
  let deadline = new AbortController();
  return {
    timeout: vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal),
    pass: () => deadline.abort(new DOMException("The operation timed out.", "TimeoutError")),
  };
}

/**
 * A real DriveApi over a Drive that answers its requests with `answers`, in turn, then takes each
 * request and never answers it, until the request is aborted; and how many requests it took.
 */
function stallingDrive(...answers: Response[]) {
  let asked = { count: 0 };
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
    asked.count++;
    let answer = answers.shift();
    if (answer) return Promise.resolve(answer);
    let { promise, reject } = Promise.withResolvers<never>();
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    return promise;
  });
  return { drive: new DriveApi(async () => "token"), asked };
}

const COPY_ACTIONS = defineActions<DriveCopiesHost, DriveCopyActions>(
  DRIVE_COPY_DEFINITIONS, { fence: "none", vendorId: "google" });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
  /** The bytes each upload sent. */
  let uploaded: string[] = [];
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
    findByToken: vi.fn<DriveApi["findByToken"]>(async () => undefined),
    // What the scope proof reads of the file, as Drive answers both from the same file.
    getConversionSource: vi.fn<DriveApi["getConversionSource"]>(async id =>
      ({ id, name: "Plan.docx", mimeType: nodes[id]?.mimeType ?? "", size: "1000" })),
    getMaxImportSize: vi.fn<DriveApi["getMaxImportSize"]>(async () => 10 * 1024 * 1024),
    openExport: vi.fn<DriveApi["openExport"]>(async (fileId, mimeType) =>
      new Response(`${fileId} as ${mimeType}`).body!),
    /** What Drive does with an upload: a new file in the folder named, made once per ID. */
    upload: vi.fn<DriveApi["upload"]>(async (content, contentType, target) => {
      uploaded.push(await text(content));
      if (!("create" in target) || target.create.id === undefined) throw new Error("Unexpected upload");
      let { id, parents } = target.create;
      if (nodes[id]) return undefined;
      nodes[id] = file(id, parents[0] ?? "", contentType);
      return { id, mimeType: contentType };
    }),
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
    madeFiles: { put: (id, fileId) => { made.set(id, fileId); } },
  };
  let journal = new ActionJournal<DriveCopyAction>(new FakeKv(), { namespace: "drive" });
  let actions = COPY_ACTIONS.bind(journal, host);
  let queue = {
    submitAction: async (_id: number, description: ActionDescription) => { described = description; },
  };
  let submit = <K extends keyof DriveCopyActions>(kind: K, payload: DriveCopyActions[K]) =>
    actions.submit(queue, kind, payload);
  return {
    api, host, journal, actions, attempts, made, nodes, hidden, submit, copy, uploaded,
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
  it("declares two auto-approvable kinds; a copy under a reserved ID goes on, a native one awaits", async () => {
    let ordinary = harness();
    let card = await ordinary.card("copyFile", intoB());
    expect(card).toMatchObject({
      autoApprovable: true, actionKind: DRIVE_COPIES, implementsRevert: false,
    });
    // An ordinary copy is shown while it waits, so the call does not wait for its decision.
    expect(card.awaitDecision).toBeUndefined();
    // Exports are a kind of their own, so a rule a user made for copies does not cover them.
    expect(ordinary.actions.autoApprovableKinds()).toEqual([DRIVE_COPIES, DRIVE_EXPORT_COPIES]);
    expect(await harness().card("copyNative", nativeIntoB())).toMatchObject({
      autoApprovable: true, actionKind: DRIVE_COPIES, awaitDecision: true,
    });
    let exported = await harness().card("exportCopy", exportIntoB());
    expect(exported).toMatchObject({
      autoApprovable: true, actionKind: DRIVE_EXPORT_COPIES, implementsRevert: false,
    });
    expect(exported.awaitDecision).toBeUndefined();
  });

  it("names the file, the folder, the copy and what the copy can be opened by", async () => {
    let card = await harness().card("copyFile", intoB());
    expect(card.title).toBe("Copy a Google Drive file");
    expect(card.description).toBe(
      "Copy Google Drive file `F` into folder `B`, as the connected account.\n\n" + TAKES_SHARING);
    expect(card.fields).toEqual([
      { label: "File", kind: "inline", value: "F" },
      { label: "File name", kind: "inline", value: "Budget.docx" },
      { label: "Copy name", kind: "inline", value: "Copy of Budget.docx" },
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

  it("says an exported copy is Google's export of the file as it is when approved", async () => {
    let card = await harness().card("exportCopy", exportIntoB());
    expect(card.description.split("\n\n")).toEqual([
      "Copy Google Drive file `F` into folder `B`, as the connected account.",
      "The copy is the file exported to pdf: Google's own conversion of the file as it is when " +
        "this is approved.",
      TAKES_SHARING,
    ]);
    expect(card.fields).toEqual([
      { label: "File", kind: "inline", value: "F" },
      { label: "File name", kind: "inline", value: "Notes" },
      { label: "Copy name", kind: "inline", value: "Notes.pdf" },
      { label: "To folder", kind: "inline", value: "B" },
      { label: "To folder name", kind: "inline", value: "Archive" },
      { label: "Exported to", kind: "inline", value: "pdf" },
    ]);
    // The bytes are Google's own, made from a file the approver can open, so the card is whole.
    expect(card.descriptionIsComplete).toBe(true);
  });
});

describe("Drive copy sends", () => {
  it("makes an ordinary copy once, under the ID reserved for it", async () => {
    let { api, journal, nodes, submit, apply } = harness();
    let id = await submit("copyFile", intoB());
    expect(await apply(id)).toBeNull();
    expect(api.copyFile).toHaveBeenCalledTimes(1);
    expect(api.copyFile).toHaveBeenCalledWith(
      "F", { id: "C", name: "Copy of Budget.docx", parents: ["B"] });
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
    expect(api.getScopeNodes).toHaveBeenCalledWith(["C", "B"]);
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

  it("leaves an ordinary copy unconfirmed while Drive shows neither its ID nor its folder", async () => {
    let { api, attempts, journal, hidden, submit, apply, copyThenAnswer } = harness();
    copyThenAnswer(unconfirmed());
    let id = await submit("copyFile", intoB());
    expect(await apply(id)).toBe(UNCONFIRMED_COPY);
    // The account loses access to the drive the copy went into: Drive answers 404 for both, as it
    // does for a file the account cannot read.
    hidden.add("C");
    hidden.add("B");
    expect(await apply(id)).toBe(UNCONFIRMED_COPY);
    expect(journal.get(id)?.state).toBe("pending");
    expect(attempts.has(id)).toBe(true);
    expect(api.copyFile).toHaveBeenCalledTimes(1);

    // Access given back, the look finds the copy.
    hidden.clear();
    expect(await apply(id)).toBeNull();
    expect(api.copyFile).toHaveBeenCalledTimes(1);
  });

  it("leaves an ordinary copy unconfirmed while its folder shows only its own metadata", async () => {
    let { api, attempts, journal, nodes, hidden, submit, apply, copyThenAnswer } = harness();
    copyThenAnswer(unconfirmed());
    let id = await submit("copyFile", intoB());
    expect(await apply(id)).toBe(UNCONFIRMED_COPY);
    // A shared drive's manager limits access to the folder's contents: Drive still answers the
    // folder, unable to list its children, and 404 for the copy in it.
    nodes.B = { ...nodes.B, canListChildren: false };
    hidden.add("C");
    expect(await apply(id)).toBe(UNCONFIRMED_COPY);
    expect(journal.get(id)?.state).toBe("pending");
    expect(attempts.has(id)).toBe(true);
    expect(api.copyFile).toHaveBeenCalledTimes(1);
  });

  it("counts a reserved ID Drive refuses as used as the copy made", async () => {
    let { api, submit, apply } = harness();
    api.copyFile.mockResolvedValueOnce(undefined);
    expect(await apply(await submit("copyFile", intoB()))).toBeNull();
    expect(api.copyFile).toHaveBeenCalledTimes(1);
  });

  it("makes a native copy with its token, clearing the markers it would keep, and records the file it made", async () => {
    let { api, made, nodes, submit, apply } = harness();
    let id = await submit("copyNative", nativeIntoB());
    expect(await apply(id)).toBeNull();
    // Drive patches a copy's app properties over its file's: a conversion's markers would offer
    // the copy for reuse as that conversion, a converted upload's token would have that upload's
    // look take the copy for the file it made, and a save's marker would let a save replace it.
    expect(api.copyFile).toHaveBeenCalledWith("F", {
      name: "Plan", parents: ["B"], mimeType: GOOGLE_DOC_MIME_TYPE,
      appProperties: {
        [COPY_TOKEN_PROPERTY]: "t0k3n", [CONVERTED_FROM_PROPERTY]: null,
        [SOURCE_MODIFIED_PROPERTY]: null, [UPLOAD_TOKEN_PROPERTY]: null, [SAVED_PROPERTY]: null,
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
    found.api.findByToken.mockResolvedValue({ id: "N1", mimeType: GOOGLE_DOC_MIME_TYPE });
    expect(await found.apply(id)).toBeNull();
    expect(found.api.findByToken).toHaveBeenCalledWith(
      COPY_TOKEN_PROPERTY, "t0k3n", { kind: "drive", driveId: "D1" }, expect.any(AbortSignal));
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
    expect(lost.api.findByToken).toHaveBeenCalledWith(
      COPY_TOKEN_PROPERTY, "t0k3n", { kind: "user" }, expect.any(AbortSignal));
  });

  // An approval sends under the one token it verified the account with, which Drive may refuse
  // as expired: the next approval's, loaded afresh, may be accepted.
  it("leaves a native copy Drive refused the approval's token for pending, and sends it at the next approval", async () => {
    let { api, attempts, journal, made, submit, apply } = harness();
    api.copyFile.mockRejectedValueOnce(new DriveApiRequestError(401, "authError"));
    let id = await submit("copyNative", nativeIntoB());
    expect(await apply(id)).toBe(CREDENTIALS_NOT_ACCEPTED);
    expect(journal.get(id)?.state).toBe("pending");
    expect(attempts.has(id)).toBe(false);

    expect(await apply(id)).toBeNull();
    expect(api.findByToken).not.toHaveBeenCalled();
    expect(api.copyFile).toHaveBeenCalledTimes(2);
    expect(made.get(id)).toBe("N1");
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
    found.api.findByToken.mockResolvedValue({ id: "N1", mimeType: DOCX });
    expect(await found.apply(again)).toBe(DIFFERENT_TYPE);
    expect(found.journal.get(again)?.state).toBe("failed");
    expect(found.made.size).toBe(0);
  });

  it("gives up on a native copy's send at Drive's write deadline, then looks for it rather than sending again", async () => {
    let { api, attempts, journal, submit, apply } = harness();
    let { timeout, pass } = deadlines();
    let { drive, asked } = stallingDrive();
    api.copyFile.mockImplementation((fileId, copy) => drive.copyFile(fileId, copy));
    let id = await submit("copyNative", nativeIntoB());
    let outcome: string | null | undefined;
    void apply(id).then(message => { outcome = message; });
    await vi.waitFor(() => expect(asked.count).toBe(1));
    expect(timeout.mock.calls).toEqual([[APPROVAL_READ_MAX_MS], [COMMENT_WRITE_MAX_MS / 3]]);
    pass();
    await vi.waitFor(() => expect(outcome).toBe(UNCONFIRMED_NATIVE_COPY));
    expect(attempts.has(id)).toBe(true);
    expect(journal.get(id)?.state).toBe("pending");

    expect(await apply(id)).toBe(UNCONFIRMED_NATIVE_COPY);
    expect(api.findByToken).toHaveBeenCalledTimes(1);
    expect(api.copyFile).toHaveBeenCalledTimes(1);
  });

  // An approval holds the binding's decisions until it settles, so none of its reads waits on
  // Drive for longer than its deadline, whatever the reads add up to.
  it("gives up on a lost native copy's search at the approval's read deadline, sending nothing", async () => {
    let { api, attempts, journal, submit, apply } = harness();
    api.copyFile.mockRejectedValueOnce(unconfirmed());
    let id = await submit("copyNative", nativeIntoB({ driveId: "D1" }));
    expect(await apply(id)).toBe(UNCONFIRMED_NATIVE_COPY);
    let { timeout, pass } = deadlines();
    // Drive answers the search's first page, and never its second.
    let { drive, asked } = stallingDrive(Response.json({ files: [], nextPageToken: "p2" }));
    api.findByToken.mockImplementation((...args) => drive.findByToken(...args));

    let outcome: string | null | undefined;
    void apply(id).then(message => { outcome = message; });
    await vi.waitFor(() => expect(asked.count).toBe(2));
    expect(timeout.mock.calls).toEqual([[APPROVAL_READ_MAX_MS]]);
    pass();
    await vi.waitFor(() => expect(outcome).toBe(UNCONFIRMED_NATIVE_COPY));
    expect(attempts.has(id)).toBe(true);
    expect(journal.get(id)?.state).toBe("pending");
    expect(api.copyFile).toHaveBeenCalledTimes(1);
  });

  // A send again in the same approval would skip the proof that the folder is still in the
  // binding's scope, and could make the copy in a folder that left it.
  it.each([
    ["Drive answers 503", false],
    ["Drive's write deadline passes", true],
  ])("sends an ordinary copy once when %s, proving its folder before sending it again", async (_, timesOut) => {
    let { api, attempts, nodes, submit, apply } = harness(AT_R);
    let id = await submit("copyFile", intoB({ folderIds: ["R", "A"] }));
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timesOut
      ? AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError"))
      : new AbortController().signal);
    let posts = 0;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      posts++;
      if (init.signal?.aborted) throw init.signal.reason;
      return Response.json({ error: { code: 503, errors: [{ reason: "backendError" }] } }, { status: 503 });
    });
    let drive = new DriveApi(async () => "token");
    api.copyFile.mockImplementation((fileId, copy) => drive.copyFile(fileId, copy));
    // Any pause before a resend passes at once.
    vi.useFakeTimers();

    let outcome = apply(id);
    await vi.runAllTimersAsync();
    expect(await outcome).toBe(UNCONFIRMED_COPY);
    expect(posts).toBe(1);
    expect(attempts.has(id)).toBe(true);

    nodes.B = folder("B", "X");
    expect(await apply(id)).toBe(OUT_OF_SCOPE);
    expect(posts).toBe(1);
  });

  it("uploads an export of the file under the ID reserved for it", async () => {
    let { api, nodes, uploaded, submit, apply } = harness();
    nodes.F = file("F", "A", GOOGLE_DOC_MIME_TYPE);
    let id = await submit("exportCopy", exportIntoB());
    expect(await apply(id)).toBeNull();
    expect(api.openExport).toHaveBeenCalledWith("F", "application/pdf");
    expect(api.upload).toHaveBeenCalledWith(
      expect.any(ReadableStream), "application/pdf",
      { create: { id: "E", name: "Notes.pdf", parents: ["B"] } });
    expect(uploaded).toEqual(["F as application/pdf"]);
    expect(nodes.E?.parents).toEqual(["B"]);
  });

  it("finds an exported copy an unanswered upload made, and never uploads it again", async () => {
    let { api, attempts, nodes, submit, apply } = harness();
    nodes.F = file("F", "A", GOOGLE_DOC_MIME_TYPE);
    let id = await submit("exportCopy", exportIntoB());
    let upload = api.upload.getMockImplementation()!;
    api.upload.mockImplementationOnce(async (...args) => {
      await upload(...args);
      throw unconfirmed();
    });
    expect(await apply(id)).toBe(UNCONFIRMED_COPY);
    expect(attempts.has(id)).toBe(true);
    expect(await apply(id)).toBeNull();
    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(api.openExport).toHaveBeenCalledTimes(1);
  });

  it("refuses an exported copy of a file the account can no longer download", async () => {
    let { api, journal, nodes, submit, apply } = harness();
    nodes.F = { ...file("F", "A", GOOGLE_DOC_MIME_TYPE), canDownload: false };
    let id = await submit("exportCopy", exportIntoB());
    expect(await apply(id)).toBe(
      "The connected account can no longer download that file, so it was not exported.");
    expect(journal.get(id)?.state).toBe("failed");
    expect(api.openExport).not.toHaveBeenCalled();
  });

  it("fails an exported copy whose export stops arriving, letting it go, and sends it again when approved again", async () => {
    vi.useFakeTimers();
    let { api, nodes, submit, apply } = harness();
    nodes.F = file("F", "A", GOOGLE_DOC_MIME_TYPE);
    let cancelled = false;
    // Drive begins the export, then sends nothing more.
    api.openExport.mockResolvedValueOnce(new ReadableStream<Uint8Array>({
      start: controller => { controller.enqueue(new TextEncoder().encode("F as")); },
      cancel: () => { cancelled = true; },
    }));
    let id = await submit("exportCopy", exportIntoB());

    let applied = apply(id);
    await vi.advanceTimersByTimeAsync(FILE_READ_IDLE_MS);
    expect(await applied).toBe(UNCONFIRMED_COPY);
    expect(cancelled).toBe(true);
    expect(nodes.E).toBeUndefined();

    // Nothing was made, so the next approval exports the file again.
    expect(await apply(id)).toBeNull();
    expect(nodes.E?.parents).toEqual(["B"]);
  });

  it("does not count the time the upload takes to send what it read of the export", async () => {
    vi.useFakeTimers();
    let { api, nodes, submit, apply } = harness();
    nodes.F = file("F", "A", GOOGLE_DOC_MIME_TYPE);
    let sent: string[] = [];
    api.upload.mockImplementationOnce(async content => {
      for await (let chunk of content) {
        sent.push(new TextDecoder().decode(chunk));
        // A chunk's send takes up to two minutes, with its retries, before the next is read.
        let { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 2 * FILE_READ_IDLE_MS);
        await promise;
      }
      nodes.E = file("E", "B");
      return { id: "E", mimeType: "application/pdf" };
    });
    let id = await submit("exportCopy", exportIntoB());

    let applied = apply(id);
    await vi.advanceTimersByTimeAsync(4 * FILE_READ_IDLE_MS);
    expect(await applied).toBeNull();
    expect(sent.join("")).toBe("F as application/pdf");
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
    expect(api.getMaxImportSize).toHaveBeenCalledWith(GOOGLE_DOC_MIME_TYPE, expect.any(AbortSignal));
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

  it("leaves a conversion pending, with nothing sent, when Drive does not answer for its file in time", async () => {
    let { api, attempts, journal, submit, apply } = harness();
    let { timeout, pass } = deadlines();
    let { drive, asked } = stallingDrive();
    api.getConversionSource.mockImplementation((...args) => drive.getConversionSource(...args));
    let id = await submit("copyNative", nativeIntoB());

    let outcome: string | null | undefined;
    void apply(id).then(message => { outcome = message; });
    await vi.waitFor(() => expect(asked.count).toBe(1));
    expect(timeout.mock.calls).toEqual([[APPROVAL_READ_MAX_MS]]);
    pass();
    await vi.waitFor(() => expect(outcome).toBe(DRIVE_DID_NOT_ANSWER));
    expect(attempts.has(id)).toBe(false);
    expect(journal.get(id)?.state).toBe("pending");
    expect(api.copyFile).not.toHaveBeenCalled();
  });

  it("converts without the import limit when Drive does not say it in time, proving the folder first", async () => {
    let { api, submit, apply } = harness();
    let { pass } = deadlines();
    let { drive, asked } = stallingDrive();
    api.getMaxImportSize.mockImplementation((...args) => drive.getMaxImportSize(...args));
    let id = await submit("copyNative", nativeIntoB());

    let outcome: string | null | undefined;
    void apply(id).then(message => { outcome = message; });
    await vi.waitFor(() => expect(asked.count).toBe(1));
    let proofs = api.getScopeNodes.mock.calls.length;
    pass();
    await vi.waitFor(() => expect(outcome).toBeNull());
    expect(api.getScopeNodes.mock.calls.length).toBeGreaterThan(proofs);
    expect(api.getScopeNodes.mock.invocationCallOrder.at(-1))
      .toBeLessThan(api.copyFile.mock.invocationCallOrder[0]);
    expect(api.copyFile).toHaveBeenCalledTimes(1);
  });

  it("refuses a conversion whose file is no longer of the Office type queued when its folder is proved", async () => {
    // Drive changes a file's type only with a new revision, which a file of another type can be:
    // before the approval, or while Drive answers a conversion's reads.
    for (let moment of ["before", "getConversionSource", "getMaxImportSize"]) {
      let { api, journal, nodes, submit, apply } = harness();
      let id = await submit("copyNative", nativeIntoB());
      let revise = () => { nodes.F = file("F", "A", "application/pdf"); };
      if (moment === "before") revise();
      if (moment === "getConversionSource") {
        api.getConversionSource.mockImplementationOnce(async fileId => {
          revise();
          return { id: fileId, name: "Plan.docx", mimeType: DOCX, size: "1000" };
        });
      }
      if (moment === "getMaxImportSize") {
        api.getMaxImportSize.mockImplementationOnce(async () => {
          revise();
          return 10 * 1024 * 1024;
        });
      }
      expect(await apply(id), moment).toBe(
        "That file is no longer a .docx, .doc, .odt or .rtf file, so it was not converted.");
      expect(journal.get(id)?.state, moment).toBe("failed");
      expect(api.copyFile, moment).not.toHaveBeenCalled();
    }
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

describe("made-file records", () => {
  // Native copies made before uploads were recorded under this key, and `pending:<n>` still names them.
  it("reads the file a native copy made under the key copies have always been kept under", () => {
    let kv = new FakeKv();
    kv.put("driveCopies:made:3", "N");
    expect(madeFiles(kv).get(3)).toBe("N");
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

  it("exports a native file, named with the format as its extension", () => {
    let doc = { name: "Notes", mimeType: GOOGLE_DOC_MIME_TYPE, canDownload: true as const };
    expect(planCopy(doc, { convertTo: "pdf" })).toEqual(
      { kind: "exportCopy", mimeType: "application/pdf", name: "Notes.pdf", format: "pdf" });
    expect(planCopy({ ...doc, name: "Notes.md" }, { convertTo: "md" }))
      .toMatchObject({ name: "Notes.md", mimeType: "text/markdown" });
    expect(planCopy(doc, { convertTo: "docx", name: "Mine.docx" })).toMatchObject({ name: "Mine.docx" });
    let { canDownload: _canDownload, ...locked } = doc;
    expect(() => planCopy(locked, { convertTo: "pdf" }))
      .toThrow("Google Drive does not let the connected account download this file");
    expect(() => planCopy(doc, { convertTo: "xlsx" }))
      .toThrow("A Google Doc does not export to xlsx");
    expect(() => planCopy({ name: "x.pdf", mimeType: "application/pdf", canDownload: true }, {
      convertTo: "txt",
    })).toThrow("Only Google Docs, Sheets and Slides files are exported.");
  });

  it("refuses what it cannot copy or convert", () => {
    expect(() => planCopy({ name: "x", mimeType: "application/pdf" }, { name: " " }))
      .toThrow("name is empty.");
    expect(() => planCopy({ name: "x.pdf", mimeType: "application/pdf" }, { convertTo: "document" }))
      .toThrow("Only a .docx, .doc, .odt or .rtf file converts to a Google Doc.");
    expect(() => planCopy({ name: "x", mimeType: GOOGLE_DOC_MIME_TYPE }, { convertTo: "document" }))
      .toThrow("That file is already a Google Doc.");
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
    entry(4, { kind: "exportCopy", payload: exportIntoB({ folderIds: ["R", "A"] }) }),
  ];

  it("shows an ordinary copy by its reserved ID, reporting the file it is a copy of", () => {
    expect(pendingFile("C", pending)).toEqual({
      entry: {
        id: "C", name: "Copy of Budget.docx", mimeType: DOCX, isFolder: false,
        modifiedTime: new Date("2026-05-01T10:00:00.000Z"), size: 1234, parentId: "B",
        pending: true,
      },
      content: { kind: "copy", sourceId: "F" },
    });
    expect(pendingFile("F", pending)).toBeUndefined();
    expect(pendingFilesInto("B", pending).map(({ entry }) => entry.id)).toEqual(["C", "E"]);
    expect(pendingFilesInto("A", pending)).toEqual([]);
  });

  it("shows an exported copy by its reserved ID, with no size until Google exports it", () => {
    expect(pendingFile("E", pending)).toEqual({
      entry: {
        id: "E", name: "Notes.pdf", mimeType: "application/pdf", isFolder: false,
        modifiedTime: new Date("2026-05-01T10:00:00.000Z"), parentId: "B", pending: true,
      },
      content: { kind: "export", sourceId: "F", format: "pdf", folderIds: ["R", "A"] },
    });
  });

  it("shows a native copy only by its pending ID", () => {
    expect(waitingFile(2, pending)?.entry).toMatchObject(
      { id: "pending:2", mimeType: GOOGLE_DOC_MIME_TYPE, pending: true });
    expect(waitingFile(1, pending)).toBeUndefined();
    expect(pendingActionId("pending:2")).toBe(2);
    expect(pendingActionId("pending:x")).toBeUndefined();
    expect(pendingActionId("C")).toBeUndefined();
  });
});
