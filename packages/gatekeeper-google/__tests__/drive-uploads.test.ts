import { createHash } from "node:crypto";
import { ActionJournal, defineActions } from "@gadgets/gatekeeper-kit/actions";
import { ActionFileStore, type ActionFileReference } from "@gadgets/gatekeeper-kit/action-files";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from "vitest";
import {
  DriveApi, DriveApiRequestError, FOLDER_MIME_TYPE, UPLOAD_TOKEN_PROPERTY, type DriveContentVersion,
  type DriveFile, type DriveScopeNode,
} from "../src/drive-api";
import { GOOGLE_DOC_MIME_TYPE, GOOGLE_SHEET_MIME_TYPE, type DriveBindingScope } from "../src/drive-session";
import {
  captureUpload, DRIVE_UPLOAD_DEFINITIONS, DRIVE_UPLOADS, MAX_UPLOADS_WAITING_BYTES,
  replacedFile, replacedVersion, UPLOAD_FILE_STORE, uploadBytes, uploadContentType, uploadConversion,
  type DriveUploadAction, type DriveUploadActions, type DriveUploadsHost,
} from "../src/drive-uploads";
import type { WriteAttempt } from "../src/drive-writes";
import { FakeKv } from "./fake-kv";

const MIB = 1024 * 1024;
const ACCOUNT: DriveBindingScope = { kind: "account" };
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TOTAL = `${UPLOAD_FILE_STORE.allocationPrefix}totalBytes`;

const TOO_LARGE = "An upload holds at most 100 MB.";
const TOO_LARGE_WHOLE =
  "A string or Uint8Array upload holds at most 25 MB. Pass a ReadableStream<Uint8Array> for a " +
  "larger file, up to 100 MB.";
const TOO_MUCH_WAITING =
  "Uploads waiting for approval here already hold close to 1 GB, so this one cannot be kept. " +
  "Upload it once some are decided.";
const NAME_TAKEN =
  "A file of that name is already in that folder. Choose another name, or pass overwrite: true " +
  "to replace that file's content.";
const NAME_AMBIGUOUS =
  "More than one file of that name is in that folder, so overwrite cannot tell which to replace. " +
  "Upload it under another name.";
const NOT_REPLACEABLE =
  "The item of that name in that folder is a folder, a shortcut or a Google file, whose content " +
  "an upload cannot replace. Upload it under another name.";
const CANNOT_EDIT =
  "The connected account cannot change the content of the file of that name in that folder.";
const NO_CHECKSUM =
  "Google Drive reports no content checksum for the file of that name in that folder, so its " +
  "content cannot be replaced here. Upload it under another name.";
const NO_FOLDER = "That folder is no longer in this connection's scope, so nothing was uploaded.";
const FOLDER_IN_TRASH = "That folder is in the trash, so nothing was uploaded into it.";
const CANNOT_UPLOAD = "The connected account can no longer add files to that folder.";
const NAME_TAKEN_SINCE =
  "A file of that name has since appeared in that folder, so nothing was uploaded. Upload it " +
  "again under another name, or with overwrite: true to replace that file.";
const BYTES_GONE =
  "The uploaded bytes are no longer kept, so nothing was uploaded. Upload the file again.";
const NO_REPLACED_FILE =
  "The file this would replace is no longer in that folder, or no longer in this connection's " +
  "scope, so nothing was replaced.";
const CHANGED_SINCE_QUEUED =
  "That file changed since this was queued, so it was not replaced: approving it would have " +
  "discarded that change from the file's current content. Upload it again to replace the file as " +
  "it is now.";
const PIN_REFUSED =
  "Google Drive refused to keep the file's current version for good, so it was not replaced. " +
  "Drive keeps at most 200 versions of a file for good: in the file's version history, stop " +
  "keeping one, then upload it again.";
const UNCONFIRMED_UPLOAD =
  "Google Drive did not confirm whether this file was uploaded, and it may have been. Approving " +
  "it again first checks for it, so it is not uploaded twice; rejecting it leaves any file that " +
  "was made.";
const UNCONFIRMED_CONVERTED =
  "Google Drive did not confirm whether this file was uploaded, and it may have been: Google " +
  "Drive can take a while to show a new file. It won't be sent again. Approving it again looks " +
  "for the file once more; rejecting it leaves any file that was made.";
const UNCONFIRMED_REPLACE =
  "Google Drive did not confirm whether the file's content was replaced, and it may have been. " +
  "Approving it again first reads the file's content checksum, so it is not replaced twice.";
const NOT_SENT =
  "Google Drive did not take the upload, and nothing was made or changed by it. Approve it again " +
  "to send it once more.";
const REPLACED_BY_OTHER =
  "That file's content is now neither what it held when this was queued nor this upload, so " +
  "whether this replacement was made cannot be told. Check the file's version history.";

/** Workerd's `crypto.DigestStream`, which the file store hashes a stream through, made in Node. */
class NodeDigestStream extends WritableStream<ArrayBuffer | ArrayBufferView> {
  readonly digest: Promise<ArrayBuffer>;

  constructor(algorithm: string) {
    let hash = createHash(algorithm.replace("-", "").toLowerCase());
    let done = Promise.withResolvers<ArrayBuffer>();
    super({
      write: chunk => {
        hash.update(ArrayBuffer.isView(chunk)
          ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : new Uint8Array(chunk));
      },
      close: () => { done.resolve(new Uint8Array(hash.digest()).buffer); },
    });
    this.digest = done.promise;
  }
}

beforeAll(() => {
  Object.defineProperty(crypto, "DigestStream", { value: NodeDigestStream, configurable: true });
});
afterAll(() => {
  Reflect.deleteProperty(crypto, "DigestStream");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** FakeKv scanned in key order within a scan's page bounds, as Durable Object storage is. */
class OrderedKv extends FakeKv {
  override list<T>(
    { prefix, startAfter, limit }: { prefix: string; startAfter?: string; limit?: number },
  ): Iterable<[string, T]> {
    let found = [...super.list<T>({ prefix })]
      .filter(([key]) => startAfter === undefined || key > startAfter)
      .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return limit === undefined ? found : found.slice(0, limit);
  }
}

/** The store an upload's bytes are kept in, as the Drive facet builds it, over its own storage. */
function uploadFiles(): { store: ActionFileStore; kv: OrderedKv } {
  let kv = new OrderedKv();
  return { store: new ActionFileStore({ kv, transactionSync: run => run() }, UPLOAD_FILE_STORE), kv };
}

/** The keys of the bytes `kv` keeps, the store's running total aside. */
function keptKeys(kv: FakeKv): string[] {
  return [...kv.entries.keys()].filter(key => key !== TOTAL);
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A stream of `count` pieces of `size` zero bytes, and whether it was cancelled. */
function zeros(count: number, size: number) {
  let cancelled = false;
  let stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (count-- > 0) controller.enqueue(new Uint8Array(size));
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, cancelled: () => cancelled };
}

function streamOf(...pieces: string[]): ReadableStream<Uint8Array> {
  return new Blob(pieces).stream();
}

describe("keeping an upload's bytes", () => {
  it("keeps a string as UTF-8, bytes as given, and a stream read to its end", async () => {
    let { store } = uploadFiles();

    let text = await captureUpload(store, uploadBytes("héllo"));
    expect(text).toMatchObject({ size: 6, digest: sha256("héllo") });
    expect(new TextDecoder().decode(await store.read(text))).toBe("héllo");

    let given = Uint8Array.of(0, 1, 2, 255);
    let bytes = await captureUpload(store, uploadBytes(given));
    expect(await store.read(bytes)).toEqual(given);

    // Across the store's own chunks, which are a mebibyte each.
    let long = "x".repeat(MIB + 5);
    let streamed = await captureUpload(store, uploadBytes(streamOf(long, "tail")));
    expect(streamed).toMatchObject({ size: MIB + 9, digest: sha256(`${long}tail`) });
    expect(new TextDecoder().decode(await store.read(streamed))).toBe(`${long}tail`);

    expect(await captureUpload(store, uploadBytes(""))).toMatchObject({ size: 0, digest: sha256("") });
  });

  it("refuses a string or bytes over 25 MiB before keeping anything", async () => {
    let { store, kv } = uploadFiles();
    // A string short enough in UTF-16 units can still be too long in UTF-8.
    for (let content of [
      "a".repeat(25 * MIB + 1), "é".repeat(12.5 * MIB + 1), new Uint8Array(25 * MIB + 1),
    ]) {
      await expect((async () => captureUpload(store, uploadBytes(content)))()).rejects
        .toThrow(TOO_LARGE_WHOLE);
    }
    expect([...kv.entries.keys()]).toEqual([]);

    expect(await captureUpload(store, uploadBytes(new Uint8Array(25 * MIB)))).toMatchObject(
      { size: 25 * MIB });
  });

  it("refuses a stream past 100 MiB, keeping none of it and cancelling the rest", async () => {
    let { store, kv } = uploadFiles();
    let { stream, cancelled } = zeros(25 * 4 + 1, MIB);

    await expect(captureUpload(store, uploadBytes(stream))).rejects.toThrow(TOO_LARGE);

    expect(keptKeys(kv)).toEqual([]);
    expect(kv.get(TOTAL)).toBe(0);
    expect(cancelled()).toBe(true);
  });

  it("refuses an upload past what the waiting uploads keep together, keeping none of it", async () => {
    let { store, kv } = uploadFiles();
    kv.put(TOTAL, MAX_UPLOADS_WAITING_BYTES - 4);

    await expect(captureUpload(store, uploadBytes("12345"))).rejects.toThrow(TOO_MUCH_WAITING);
    await expect(captureUpload(store, uploadBytes(streamOf("12345")))).rejects.toThrow(TOO_MUCH_WAITING);
    expect(keptKeys(kv)).toEqual([]);
    expect(kv.get(TOTAL)).toBe(MAX_UPLOADS_WAITING_BYTES - 4);

    expect(await captureUpload(store, uploadBytes("1234"))).toMatchObject({ size: 4 });
  });
});

describe("uploadContentType", () => {
  it("takes the type given, else the name's extension, else the replaced file's, else the content's", () => {
    let stream = streamOf("x");
    expect(uploadContentType("a.png", "x", "image/webp")).toBe("image/webp");
    expect(uploadContentType("Report.PDF", new Uint8Array(), undefined)).toBe("application/pdf");
    expect(uploadContentType("notes.md", "x", undefined, "text/csv")).toBe("text/markdown");
    expect(uploadContentType("notes", "x", undefined, "text/csv")).toBe("text/csv");
    expect(uploadContentType("notes.constructor", "x", undefined, "text/csv")).toBe("text/csv");
    expect(uploadContentType("notes", "x", undefined)).toBe("text/plain");
    expect(uploadContentType("notes", new Uint8Array(), undefined)).toBe("application/octet-stream");
    expect(uploadContentType("notes.tar", stream, undefined)).toBe("application/octet-stream");
    expect(uploadContentType("plan.docx", "x", undefined)).toBe(DOCX);
  });

  it("refuses a type that is not one, and Google's own types", () => {
    expect(() => uploadContentType("a", "x", "not a type")).toThrow("mimeType is not a MIME type.");
    expect(() => uploadContentType("a", "x", "Application/Vnd.Google-Apps.Document")).toThrow(
      "mimeType names a Google file type, which an upload cannot be. Upload an Office file with " +
      "convertTo to make a Google file.");
  });
});

describe("uploadConversion", () => {
  it("converts an Office file into its Google type, named without its extension", () => {
    expect(uploadConversion("Plan.docx", DOCX, "document"))
      .toEqual({ mimeType: GOOGLE_DOC_MIME_TYPE, name: "Plan" });
  });

  // Drive imports CSV and TSV into Sheets, as it does Excel files.
  it("converts a CSV or TSV file into a Google Sheet, named without its extension", () => {
    let csv = uploadContentType("sales.csv", "region,total\nWest,42", undefined);
    expect(uploadConversion("sales.csv", csv, "spreadsheet"))
      .toEqual({ mimeType: GOOGLE_SHEET_MIME_TYPE, name: "sales" });
    expect(uploadConversion("Sales.TSV", "text/tab-separated-values", "spreadsheet"))
      .toEqual({ mimeType: GOOGLE_SHEET_MIME_TYPE, name: "Sales" });
    expect(uploadConversion("export", "text/csv", "spreadsheet"))
      .toEqual({ mimeType: GOOGLE_SHEET_MIME_TYPE, name: "export" });
  });

  it("refuses a type that does not convert into the one asked for", () => {
    expect(() => uploadConversion("sales.csv", "text/csv", "document"))
      .toThrow("Only a .docx, .doc, .odt or .rtf file converts to a Google Doc.");
    expect(() => uploadConversion("photo.png", "image/png", "spreadsheet"))
      .toThrow("Only an .xlsx, .xls, .xlsm, .ods, .csv or .tsv file converts to a Google Sheet.");
  });
});

describe("what overwrite replaces", () => {
  let named = (id: string, mimeType = "text/plain"): DriveFile => ({ id, name: "a.txt", mimeType });

  it("replaces the one ordinary file of the name, and refuses any other", () => {
    expect(replacedFile([], false)).toBeUndefined();
    expect(replacedFile([], true)).toBeUndefined();
    expect(replacedFile([named("F")], true)).toEqual(named("F"));
    expect(() => replacedFile([named("F")], false)).toThrow(NAME_TAKEN);
    expect(() => replacedFile([named("F")], undefined)).toThrow(NAME_TAKEN);
    expect(() => replacedFile([named("F"), named("G")], true)).toThrow(NAME_AMBIGUOUS);
    for (let mimeType of [FOLDER_MIME_TYPE, GOOGLE_DOC_MIME_TYPE, "application/vnd.google-apps.shortcut"]) {
      expect(() => replacedFile([named("F", mimeType)], true), mimeType).toThrow(NOT_REPLACEABLE);
    }
  });

  it("records the version replaced, refused without a checksum to tell it by", () => {
    let version: DriveContentVersion = {
      id: "F", headRevisionId: "rev-1", sha256Checksum: sha256("old"), size: "3",
      modifiedTime: "2026-05-01T10:00:00.000Z", canEdit: true,
    };
    expect(replacedVersion(version)).toEqual({
      headRevisionId: "rev-1", sha256Checksum: sha256("old"), size: 3,
      modifiedTime: "2026-05-01T10:00:00.000Z",
    });
    expect(() => replacedVersion({ ...version, canEdit: false })).toThrow(CANNOT_EDIT);
    let { sha256Checksum: _checksum, ...native } = version;
    expect(() => replacedVersion(native)).toThrow(NO_CHECKSUM);
    let { headRevisionId: _revision, ...unrevised } = version;
    expect(() => replacedVersion(unrevised)).toThrow(NO_CHECKSUM);
  });
});

const UPLOAD_ACTIONS = defineActions<DriveUploadsHost, DriveUploadActions>(
  DRIVE_UPLOAD_DEFINITIONS, { fence: "none", vendorId: "google" });

const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected call");
};

/** Drive's answer to a send whose outcome it leaves open. */
const unconfirmed = () => new DriveApiRequestError(503, "backendError");

/** A live folder the account can add to, as a scope proof reads it. */
function folder(id: string, parent: string): DriveScopeNode {
  return {
    id, mimeType: FOLDER_MIME_TYPE, parents: [parent], trashed: false, canListChildren: true,
    canAddChildren: true,
  };
}

const SESSION = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=S";

/**
 * Has `api` upload through Drive's own client over a fetch that answers each request with
 * `answer`, given its method and `Content-Range`. Returns the requests, each as its method and
 * range.
 */
function throughDrive(
  api: { upload: Mock<DriveApi["upload"]> },
  answer: (method: string, range: string | null) => Response,
): string[] {
  let requests: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    let method = init.method ?? "GET";
    let range = new Headers(init.headers).get("Content-Range");
    requests.push(range === null ? method : `${method} ${range}`);
    return answer(method, range);
  });
  let drive = new DriveApi(async () => "tok");
  api.upload.mockImplementation((...args) => drive.upload(...args));
  return requests;
}

/** Drive's answers to an upload session, which holds each chunk sent before the last. */
function session(made: string) {
  return (method: string, range: string | null): Response => {
    if (method === "POST" || method === "PATCH") return new Response(null, { headers: { Location: SESSION } });
    if (method === "DELETE" || !range) return new Response(null);
    let [, last, total] = /^bytes \d+-(\d+)\/(\d+|\*)$/.exec(range) ?? [];
    return total === "*"
      ? new Response(null, { status: 308, headers: { Range: `bytes=0-${last}` } })
      : new Response(JSON.stringify({ id: made }));
  };
}

/**
 * The upload set over an in-memory journal and a real file store, with a host whose Drive holds
 * folder `B` and, in it, file `R` at revision `rev-1` holding `old`, which an upload replaces.
 */
function harness(scope: DriveBindingScope = ACCOUNT) {
  let { store } = uploadFiles();
  let nodes: Record<string, DriveScopeNode | undefined> = {
    B: folder("B", "A"),
    R: { id: "R", mimeType: "text/plain", parents: ["B"], trashed: false, canEdit: true },
  };
  let version: DriveContentVersion = {
    id: "R", headRevisionId: "rev-1", sha256Checksum: sha256("old"), size: "3", canEdit: true,
  };
  let attempts = new Map<number, WriteAttempt>();
  let made = new Map<number, string>();
  /** What each upload sent: its bytes, type and target. */
  let uploaded: { content: string; contentType: string; target: unknown }[] = [];
  let described: ActionDescription | undefined;
  let nextFile = 1;
  /**
   * What Drive does with an upload: a new file, made once per ID, or new content for a file, once
   * the check before the request that makes it has passed.
   */
  let upload: DriveApi["upload"] = async (content, contentType, target, beforeCommit) => {
    let text = await new Response(content).text();
    await beforeCommit?.();
    uploaded.push({ content: text, contentType, target });
    if ("replace" in target) {
      version = { ...version, headRevisionId: `rev-${++nextFile}`, sha256Checksum: sha256(text) };
      return { id: target.replace, mimeType: contentType };
    }
    let id = target.create.id ?? `N${nextFile++}`;
    if (nodes[id]) return undefined;
    nodes[id] = { id, mimeType: target.create.mimeType ?? contentType, parents: target.create.parents };
    return { id, mimeType: nodes[id].mimeType };
  };
  let api = {
    getScopeNodes: vi.fn<DriveApi["getScopeNodes"]>(async ids =>
      ids.map(id => nodes[id] && structuredClone(nodes[id]))),
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
    findByToken: vi.fn<DriveApi["findByToken"]>(async () => undefined),
    findNamed: vi.fn<DriveApi["findNamed"]>(async () => []),
    getContentVersion: vi.fn<DriveApi["getContentVersion"]>(async () => ({ ...version })),
    keepRevision: vi.fn<DriveApi["keepRevision"]>(async () => {}),
    upload: vi.fn<DriveApi["upload"]>(upload),
  };
  let host: DriveUploadsHost = {
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
    uploads: { readStream: file => store.readStream(file) },
  };
  let journal = new ActionJournal<DriveUploadAction>(new FakeKv(), { namespace: "drive" });
  let actions = UPLOAD_ACTIONS.bind(journal, host);
  let queue = {
    submitAction: async (_id: number, description: ActionDescription) => { described = description; },
  };
  let submit = <K extends keyof DriveUploadActions>(kind: K, payload: DriveUploadActions[K]) =>
    actions.submit(queue, kind, payload);
  /** What every upload of `content`, kept in the store, carries into folder `B`. */
  let base = async (content: string) => ({
    name: "notes.txt", contentType: "text/plain", file: await store.capture(new TextEncoder().encode(content)),
    toFolderId: "B", toName: "Archive", queuedAt: "2026-05-01T10:00:00.000Z",
  });
  return {
    api, journal, actions, attempts, made, nodes, store, uploaded, submit, upload,
    /** Points the file Drive holds as `R` at another version. */
    change(changes: Partial<DriveContentVersion>): void {
      version = { ...version, ...changes };
    },
    newFile: async (content: string): Promise<DriveUploadActions["uploadFile"]> =>
      ({ ...await base(content), fileId: "U" }),
    converted: async (content: string): Promise<DriveUploadActions["uploadConverted"]> =>
      ({ ...await base(content), name: "plan", contentType: DOCX, token: "t0k3n", convertTo: "document" }),
    replacement: async (content: string): Promise<DriveUploadActions["replaceFile"]> => ({
      ...await base(content), fileId: "R",
      replaced: { headRevisionId: "rev-1", sha256Checksum: sha256("old"), size: 3 },
    }),
    async card<K extends keyof DriveUploadActions>(
      kind: K, payload: DriveUploadActions[K],
    ): Promise<ActionDescription> {
      await submit(kind, payload);
      if (!described) throw new Error("nothing was described");
      return described;
    },
    /** Applies an action, answering `null` when it applied and the failure's message otherwise. */
    apply: (id: number): Promise<string | null> =>
      actions.apply(id).then(() => null, (error: Error) => error.message),
    /** Makes the next upload do what Drive does with it, then answer `error`. */
    uploadThenAnswer(error: Error): void {
      api.upload.mockImplementationOnce(async (...args) => {
        await upload(...args);
        throw error;
      });
    },
    /** Makes the next upload send its last chunk, which Drive does not make, then answer `error`. */
    lastChunkLost(error: Error): void {
      api.upload.mockImplementationOnce(async (content, _contentType, _target, beforeCommit) => {
        await new Response(content).text();
        await beforeCommit?.();
        throw error;
      });
    },
  };
}

describe("Drive upload verdicts and approval cards", () => {
  it("lets uploads go on rules, as posts into the bound folder, and never a replacement", async () => {
    let plain = harness();
    let card = await plain.card("uploadFile", await plain.newFile("hello"));
    expect(card).toMatchObject({
      title: "Upload a file to Google Drive", actionKind: DRIVE_UPLOADS, autoApprovable: true,
      implementsRevert: false,
    });
    // Shown under its reserved ID while it waits, so the call does not wait for its decision.
    expect(card.awaitDecision).toBeUndefined();
    expect(plain.actions.autoApprovableKinds()).toEqual([DRIVE_UPLOADS]);

    let converting = harness();
    expect(await converting.card("uploadConverted", await converting.converted("docx"))).toMatchObject({
      actionKind: DRIVE_UPLOADS, autoApprovable: true, awaitDecision: true,
    });
    // Rule 1: it replaces what the file holds.
    let replacing = harness();
    let replace = await replacing.card("replaceFile", await replacing.replacement("new"));
    expect(replace).toMatchObject({
      title: "Replace a Google Drive file's content", actionKind: DRIVE_UPLOADS, autoApprovable: false,
      awaitDecision: true,
    });
    expect(replace.description).toContain("Its current version stays in its version history");
  });

  it("shows the bytes as the file they make, which the card cannot hold whole", async () => {
    let { card, newFile } = harness();
    let shown = await card("uploadFile", await newFile("hello"));
    expect(shown.fields).toEqual([
      { label: "Name", kind: "inline", value: "notes.txt" },
      { label: "To folder", kind: "inline", value: "B" },
      { label: "To folder name", kind: "inline", value: "Archive" },
      { label: "Type", kind: "inline", value: "text/plain" },
      { label: "Size", kind: "inline", value: "5 bytes" },
      {
        label: "File", kind: "file", name: "notes.txt", mediaType: "text/plain", size: 5,
        sha256: sha256("hello"), origin: "agent",
      },
    ]);
    expect(shown.descriptionIsComplete).toBeUndefined();
  });
});

describe("Drive upload sends", () => {
  it("uploads the kept bytes once, under the ID reserved for the file", async () => {
    let { api, journal, uploaded, nodes, submit, apply, newFile } = harness();
    let id = await submit("uploadFile", await newFile("hello"));
    expect(await apply(id)).toBeNull();
    expect(uploaded).toEqual([{
      content: "hello", contentType: "text/plain",
      target: { create: { id: "U", name: "notes.txt", parents: ["B"] } },
    }]);
    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(nodes.U?.parents).toEqual(["B"]);
    expect(journal.get(id)).toBeUndefined();
  });

  it("looks for a file of the name in the folder's own drive at approval", async () => {
    let { api, nodes, submit, apply, newFile } = harness();
    nodes.B = { ...folder("B", "A"), driveId: "D" };
    expect(await apply(await submit("uploadFile", await newFile("hello")))).toBeNull();
    expect(api.findNamed).toHaveBeenCalledWith("B", "notes.txt", { kind: "drive", driveId: "D" });
  });

  it("finds the file an unanswered upload made under its ID, and never uploads it again", async () => {
    let { api, attempts, journal, submit, apply, newFile, uploadThenAnswer } = harness();
    uploadThenAnswer(unconfirmed());
    let id = await submit("uploadFile", await newFile("hello"));
    expect(await apply(id)).toBe(UNCONFIRMED_UPLOAD);
    expect(journal.get(id)?.state).toBe("pending");
    expect(attempts.has(id)).toBe(true);
    expect(await apply(id)).toBeNull();
    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(api.getScopeNodes).toHaveBeenLastCalledWith(["U"]);
  });

  it("uploads again under the same ID when none was made, and counts the ID refused as used as made", async () => {
    let lost = harness();
    lost.lastChunkLost(unconfirmed());
    let id = await lost.submit("uploadFile", await lost.newFile("hello"));
    expect(await lost.apply(id)).toBe(UNCONFIRMED_UPLOAD);
    expect(await lost.apply(id)).toBeNull();
    expect(lost.uploaded.map(({ content }) => content)).toEqual(["hello"]);
    expect(lost.api.upload.mock.calls[1]?.[2]).toMatchObject({ create: { id: "U" } });

    let used = harness();
    used.api.upload.mockResolvedValueOnce(undefined);
    expect(await used.apply(await used.submit("uploadFile", await used.newFile("hello")))).toBeNull();
    expect(used.api.upload).toHaveBeenCalledTimes(1);
  });

  it("refuses at approval an upload that can no longer be made, uploading nothing", async () => {
    /** What a case may change between the queueing and the approval. */
    type Since = {
      nodes: Record<string, DriveScopeNode | undefined>; store: ActionFileStore;
      file: ActionFileReference; findNamed: Mock<DriveApi["findNamed"]>;
    };
    let cases: [string, (since: Since) => void, string][] = [
      ["a file of that name since", ({ findNamed }) => {
        findNamed.mockResolvedValue([{ id: "X", name: "notes.txt", mimeType: "text/plain" }]);
      }, NAME_TAKEN_SINCE],
      ["bytes gone", ({ store, file }) => { store.delete(file); }, BYTES_GONE],
      ["folder in the trash", ({ nodes }) => { nodes.B = { ...folder("B", "A"), trashed: true }; },
        FOLDER_IN_TRASH],
      ["folder closed", ({ nodes }) => { nodes.B = { ...folder("B", "A"), canAddChildren: false }; },
        CANNOT_UPLOAD],
      ["folder gone", ({ nodes }) => { nodes.B = undefined; }, NO_FOLDER],
    ];
    for (let [what, change, message] of cases) {
      let { api, journal, nodes, store, submit, apply, newFile } = harness();
      let payload = await newFile("hello");
      let id = await submit("uploadFile", payload);
      change({ nodes, store, file: payload.file, findNamed: api.findNamed });
      expect(await apply(id), what).toBe(message);
      expect(journal.get(id)?.state, what).toBe("failed");
      expect(api.upload, what).not.toHaveBeenCalled();
    }
  });
});

describe("Drive converted upload sends", () => {
  it("uploads with its token and no ID, and records the file Drive made", async () => {
    let { api, made, nodes, submit, apply, converted } = harness();
    let id = await submit("uploadConverted", await converted("docx bytes"));
    expect(await apply(id)).toBeNull();
    expect(api.upload).toHaveBeenCalledWith(expect.any(ReadableStream), DOCX, {
      create: {
        name: "plan", parents: ["B"], mimeType: GOOGLE_DOC_MIME_TYPE,
        appProperties: { [UPLOAD_TOKEN_PROPERTY]: "t0k3n" },
      },
    }, expect.any(Function));
    expect(made.get(id)).toBe("N1");
    expect(nodes.N1?.mimeType).toBe(GOOGLE_DOC_MIME_TYPE);
  });

  it("finds a converted upload by its token, and never sends one twice", async () => {
    let found = harness();
    found.uploadThenAnswer(unconfirmed());
    let id = await found.submit("uploadConverted", await found.converted("docx"));
    expect(await found.apply(id)).toBe(UNCONFIRMED_CONVERTED);
    found.api.findByToken.mockResolvedValue({ id: "N1", mimeType: GOOGLE_DOC_MIME_TYPE });
    expect(await found.apply(id)).toBeNull();
    expect(found.api.findByToken).toHaveBeenCalledWith(
      UPLOAD_TOKEN_PROPERTY, "t0k3n", { kind: "user" }, expect.any(AbortSignal));
    expect(found.api.upload).toHaveBeenCalledTimes(1);
    expect(found.made.get(id)).toBe("N1");

    // Drive's search lags, so a look that finds nothing proves nothing.
    let lost = harness();
    lost.lastChunkLost(unconfirmed());
    let again = await lost.submit("uploadConverted", await lost.converted("docx"));
    expect(await lost.apply(again)).toBe(UNCONFIRMED_CONVERTED);
    expect(await lost.apply(again)).toBe(UNCONFIRMED_CONVERTED);
    expect(lost.api.upload).toHaveBeenCalledTimes(1);
    expect(lost.journal.get(again)?.state).toBe("pending");
    expect(lost.made.size).toBe(0);
  });

  it("keeps a converted upload to look for when Drive refuses to say what the session holds after its last chunk", async () => {
    vi.useFakeTimers();
    let { api, attempts, journal, made, submit, apply, converted } = harness();
    let requests = throughDrive(api, (method, range) => {
      // The last chunk's answer is lost, and Drive then refuses the question of what it holds.
      if (method === "PUT" && range === "bytes 0-3/4") throw new TypeError("network connection lost");
      if (method === "PUT") {
        return new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: "forbidden" }] } }),
          { status: 403 });
      }
      return session("N1")(method, range);
    });
    let id = await submit("uploadConverted", await converted("docx"));
    let applied = apply(id);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await applied).toBe(UNCONFIRMED_CONVERTED);
    expect(requests).toEqual(["POST", "PUT bytes 0-3/4", "PUT bytes */4", "DELETE"]);
    expect(journal.get(id)?.state).toBe("pending");
    expect(attempts.has(id)).toBe(true);

    api.findByToken.mockResolvedValue({ id: "N1", mimeType: GOOGLE_DOC_MIME_TYPE });
    expect(await apply(id)).toBeNull();
    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(made.get(id)).toBe("N1");
  });

  it("leaves a converted upload to send again when Drive would not open its session, which made nothing", async () => {
    vi.useFakeTimers();
    let { api, attempts, journal, made, submit, apply, converted } = harness();
    let down = true;
    let requests = throughDrive(api, (method, range) =>
      method === "POST" && down ? new Response("{}", { status: 503 }) : session("N1")(method, range));
    let id = await submit("uploadConverted", await converted("docx"));
    let applied = apply(id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await applied).toBe(NOT_SENT);
    expect(requests).toEqual(["POST", "POST", "POST"]);
    expect(journal.get(id)?.state).toBe("pending");
    expect(attempts.has(id)).toBe(false);

    down = false;
    expect(await apply(id)).toBeNull();
    expect(requests.slice(3)).toEqual(["POST", "PUT bytes 0-3/4"]);
    expect(api.findByToken).not.toHaveBeenCalled();
    expect(made.get(id)).toBe("N1");
  });
});

describe("Drive replacement sends", () => {
  it("keeps the head revision for good before replacing the content", async () => {
    let { api, uploaded, submit, apply, replacement } = harness();
    let id = await submit("replaceFile", await replacement("new"));
    expect(await apply(id)).toBeNull();
    expect(api.keepRevision).toHaveBeenCalledWith("R", "rev-1");
    expect(api.keepRevision.mock.invocationCallOrder[0])
      .toBeLessThan(api.upload.mock.invocationCallOrder[0]);
    expect(uploaded).toEqual([{ content: "new", contentType: "text/plain", target: { replace: "R" } }]);
  });

  it("refuses a file whose content changed since it was queued, keeping and replacing nothing", async () => {
    for (let moved of [{ headRevisionId: "rev-9" }, { sha256Checksum: sha256("edited") }]) {
      let { api, journal, submit, apply, replacement, change } = harness();
      let id = await submit("replaceFile", await replacement("new"));
      change(moved);
      expect(await apply(id)).toBe(CHANGED_SINCE_QUEUED);
      expect(journal.get(id)?.state).toBe("failed");
      expect(api.keepRevision).not.toHaveBeenCalled();
      expect(api.upload).not.toHaveBeenCalled();
    }
  });

  it("proves the file again once its version is read, keeping and replacing nothing when it left the binding", async () => {
    let { api, journal, nodes, submit, apply, replacement } = harness({ kind: "folder", folderId: "A" });
    nodes.A = folder("A", "root");
    let read = api.getContentVersion.getMockImplementation()!;
    api.getContentVersion.mockImplementationOnce(async fileId => {
      // Moved out of the bound folder while its version is read.
      nodes.R = { ...nodes.R!, parents: ["elsewhere"] };
      return read(fileId);
    });
    let id = await submit("replaceFile", { ...await replacement("new"), folderIds: ["A"] });
    expect(await apply(id)).toBe(NO_REPLACED_FILE);
    expect(journal.get(id)?.state).toBe("failed");
    expect(api.keepRevision).not.toHaveBeenCalled();
    expect(api.upload).not.toHaveBeenCalled();
  });

  it("refuses for good when Drive will not keep the version, and waits out a rate limit or a pin it did not answer", async () => {
    for (let [refusal, said] of [
      [new DriveApiRequestError(403, "keepForeverLimit"), `${PIN_REFUSED} [http=403 reason=keepForeverLimit]`],
      [new DriveApiRequestError(400), `${PIN_REFUSED} [http=400]`],
    ] as const) {
      let { api, journal, submit, apply, replacement } = harness();
      api.keepRevision.mockRejectedValueOnce(refusal);
      let id = await submit("replaceFile", await replacement("new"));
      expect(await apply(id)).toBe(said);
      expect(journal.get(id)?.state).toBe("failed");
      expect(api.upload).not.toHaveBeenCalled();
    }

    for (let later of [
      new DriveApiRequestError(403, "userRateLimitExceeded"),
      new DOMException("The operation timed out.", "TimeoutError"),
    ]) {
      let { api, attempts, journal, submit, apply, replacement, uploaded } = harness();
      api.keepRevision.mockRejectedValueOnce(later);
      let id = await submit("replaceFile", await replacement("new"));
      expect(await apply(id), later.name).not.toBeNull();
      expect(journal.get(id)?.state, later.name).toBe("pending");
      expect(attempts.has(id), later.name).toBe(false);
      expect(api.upload, later.name).not.toHaveBeenCalled();
      expect(await apply(id), later.name).toBeNull();
      expect(uploaded.map(({ content }) => content), later.name).toEqual(["new"]);
    }
  });

  it("tells by the content's checksum whether a replacement whose answer was lost was made", async () => {
    // Made: the checksum is the upload's.
    let made = harness();
    made.uploadThenAnswer(unconfirmed());
    let id = await made.submit("replaceFile", await made.replacement("new"));
    expect(await made.apply(id)).toBe(UNCONFIRMED_REPLACE);
    expect(await made.apply(id)).toBeNull();
    expect(made.api.upload).toHaveBeenCalledTimes(1);

    // Not made: the checksum is still the one recorded, so it is sent again.
    let none = harness();
    none.lastChunkLost(unconfirmed());
    let again = await none.submit("replaceFile", await none.replacement("new"));
    expect(await none.apply(again)).toBe(UNCONFIRMED_REPLACE);
    expect(await none.apply(again)).toBeNull();
    expect(none.uploaded.map(({ content }) => content)).toEqual(["new"]);
    expect(none.api.upload).toHaveBeenCalledTimes(2);

    // Someone else's content: whether this one was made cannot be told, so it is left to the
    // approver, and never sent again.
    let other = harness();
    other.uploadThenAnswer(unconfirmed());
    let theirs = await other.submit("replaceFile", await other.replacement("new"));
    expect(await other.apply(theirs)).toBe(UNCONFIRMED_REPLACE);
    other.change({ sha256Checksum: sha256("theirs") });
    expect(await other.apply(theirs)).toBe(REPLACED_BY_OTHER);
    expect(other.journal.get(theirs)?.state).toBe("failed");
    await other.apply(theirs);
    expect(other.api.upload).toHaveBeenCalledTimes(1);
  });
});

describe("Drive upload scope at the request that makes the file", () => {
  const AT_A: DriveBindingScope = { kind: "folder", folderId: "A" };
  const CHUNK = 8 * MIB;

  it("proves the folder, and the file replaced, again before the last chunk, sending it no further once either left", async () => {
    let cases: [string, "uploadFile" | "replaceFile", string][] = [
      ["the folder moved", "uploadFile", NO_FOLDER], ["the file moved", "replaceFile", NO_REPLACED_FILE],
    ];
    for (let [what, kind, message] of cases) {
      let { api, attempts, journal, nodes, submit, apply, newFile, replacement } = harness(AT_A);
      nodes.A = folder("A", "root");
      let content = "x".repeat(CHUNK + 2);
      let requests = throughDrive(api, (method, range) => {
        // Moved out of the bound folder while the first chunk goes.
        if (method === "PUT") {
          if (kind === "uploadFile") nodes.B = folder("B", "elsewhere");
          else nodes.R = { ...nodes.R!, parents: ["elsewhere"] };
        }
        return session(kind === "uploadFile" ? "U" : "R")(method, range);
      });
      let id = kind === "uploadFile"
        ? await submit(kind, { ...await newFile(content), folderIds: ["A"] })
        : await submit(kind, { ...await replacement(content), folderIds: ["A"] });

      expect(await apply(id), what).toBe(message);
      expect(requests.slice(1), what).toEqual([`PUT bytes 0-${CHUNK - 1}/*`, "DELETE"]);
      expect(journal.get(id)?.state, what).toBe("failed");
      expect(attempts.has(id), what).toBe(false);
    }
  });
});
