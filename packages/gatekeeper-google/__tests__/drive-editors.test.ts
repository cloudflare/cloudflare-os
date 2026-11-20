import { ActionApplyError, ActionJournal, type ActionDefinition } from "@gadgets/gatekeeper-kit/actions";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { DRIVE_ACTIONS, type DriveAction, type DriveHost } from "../src/drive-actions";
import type { DriveScopeNode } from "../src/drive-api";
import {
  DRIVE_SLIDES_DEFINITIONS, DriveFileEditors, editedFile, editOf, editorMimeType, editorOfMimeType,
  editorOfTag, EDIT_IN_TRASH, EDIT_NOT_ALLOWED, EDIT_OUT_OF_ORDER, EDIT_OUT_OF_SCOPE, onDriveFile,
  unreachedBy, type DriveEdit, type DriveEditorsHost,
} from "../src/drive-editors";
import {
  GOOGLE_DOC_MIME_TYPE, GOOGLE_SHEET_MIME_TYPE, GOOGLE_SLIDES_MIME_TYPE,
} from "../src/drive-session";
import {
  DOC_COPY_EXPIRY_PASS_KEY, DRIVE_DOC_COPY_EXPIRY_MS, lazyDocStore, MAX_DRIVE_DOC_COPIES,
  MAX_DRIVE_DOC_COPY_BYTES,
} from "../src/docs-copy";
import { MARKDOWN_RENDERING_VERSION } from "../src/markdown-converter";
import { buildTab } from "./doc-fixture";
import { countedStorage } from "./doc-store-scenarios";
import { fakeDocStorage, fakeDocStore } from "./doc-store-fake";
import type { GoogleDocAction } from "../src/doc-actions";
import { docEditKey } from "../src/docs-replay";
import { pruneTab } from "../src/docs-replica";
import { DocStore } from "../src/docs-store";
import { DEPLOYMENT_READ_ONLY, WRITES_GRANT_MISSING } from "../src/drive-writes";
import { SLIDES_DEFINITIONS, type SlidesHost } from "../src/slides-actions";
import type { SlidesActions } from "../src/slides-simulation";
import { DRIVE_DOCS_KINDS, DRIVE_SHEETS_KINDS, DRIVE_SLIDES_KINDS } from "./drive-edit-kinds";
import type { GoogleDocsApi, GoogleDocsDocument } from "../src/docs-api";
import type { GoogleSheetsApi } from "../src/sheets-api";
import { FakeKv } from "./fake-kv";

const SKIP: SlidesActions["skipSlides"] = {
  slideIds: ["s1"], skipped: true, slides: [{ number: 1, title: "Q3 review" }],
};
const TARGET = { fileId: "deck-1", fileName: "Q3 deck" };

/** A Drive host whose Slides host for each file is `slides(fileId)`. */
function host(slides: (fileId: string) => SlidesHost): DriveEditorsHost {
  return {
    editors: {
      slides,
      sheets: () => { throw new Error("No spreadsheet is edited here."); },
      docs: () => { throw new Error("No Doc is edited here."); },
      prove: async () => {},
    },
  };
}

/** A host whose Slides API is never asked: describing a change reads only its payload. */
const NO_SLIDES = host(fileId => ({ api: {} as SlidesHost["api"], presentationId: fileId }));

describe("Slides definitions reused through Drive", () => {
  it("keep each definition's name, tag, verdict, delivery and claim, and say the kind covers every presentation", () => {
    expect(Object.keys(DRIVE_SLIDES_DEFINITIONS)).toEqual(Object.keys(SLIDES_DEFINITIONS));
    for (let [name, own] of Object.entries(SLIDES_DEFINITIONS)) {
      let drive = DRIVE_SLIDES_DEFINITIONS[name as keyof SlidesActions];
      expect(drive.kind, name).toEqual({
        tag: own.kind.tag, label: `${own.kind.label}, in any presentation this connection reaches`,
      });
      expect(drive.autoApprovable, name).toBe(own.autoApprovable);
      expect(drive.delivery, name).toBe(own.delivery);
      expect(drive.claimBeforeApply, name).toBe(own.claimBeforeApply);
    }
  });

  it("show the editor's card with the file's ID and name first", async () => {
    let own = await SLIDES_DEFINITIONS.skipSlides.describe(SKIP, undefined as never);
    let card = await DRIVE_SLIDES_DEFINITIONS.skipSlides.describe(
      { target: TARGET, change: SKIP }, NO_SLIDES);

    expect(card).toEqual({
      ...own,
      fields: [
        { label: "File", kind: "inline", value: "deck-1" },
        { label: "File name", kind: "inline", value: "Q3 deck" },
        ...own.fields ?? [],
      ],
    });
    expect(own.descriptionIsComplete).toBe(true);
    expect(card.descriptionIsComplete).toBe(true);
  });

  it("show a name with an invisible character exactly, and a card without a name with the ID alone", async () => {
    let hidden = await DRIVE_SLIDES_DEFINITIONS.skipSlides.describe(
      { target: { fileId: "deck-1", fileName: "Q3‮deck" }, change: SKIP }, NO_SLIDES);
    expect(hidden.fields?.[1]).toEqual({ label: "File name", kind: "json", value: "\"Q3\\u202edeck\"" });
    expect(hidden.descriptionIsComplete).toBe(true);

    let unnamed = await DRIVE_SLIDES_DEFINITIONS.skipSlides.describe(
      { target: { fileId: "deck-1" }, change: SKIP }, NO_SLIDES);
    expect(unnamed.fields?.map(field => field.label)).toEqual(["File"]);
  });

  it("are complete only when the editor's card is", async () => {
    let definition: ActionDefinition<string, unknown> = {
      kind: { tag: "t", label: "Things" }, autoApprovable: true, delivery: "continue-with-simulation",
      describe: text => ({ title: "Do", description: text, implementsRevert: false }),
      apply: async () => {},
    };
    let editor = { name: "slides" as const, mimeType: GOOGLE_SLIDES_MIME_TYPE, noun: "thing", host: () => ({}) };
    let card = await onDriveFile(definition, editor).describe({ target: TARGET, change: "x" }, NO_SLIDES);
    expect(card).not.toHaveProperty("descriptionIsComplete");
    expect(card.fields).toHaveLength(2);
  });

  it("apply the change to the file the record names, through that file's host", async () => {
    let calls: unknown[][] = [];
    let editor = {
      name: "slides" as const, mimeType: GOOGLE_SLIDES_MIME_TYPE, noun: "thing",
      host: (_drive: DriveEditorsHost, fileId: string) => ({ fileId }),
    };
    let definition: ActionDefinition<string, { fileId: string }> = {
      kind: { tag: "t", label: "Things" }, autoApprovable: true, delivery: "continue-with-simulation",
      describe: () => ({ title: "Do", description: "", implementsRevert: false }),
      apply: async (change, fileHost, ctx) => {
        calls.push([change, fileHost, ctx.id]);
        return { action: `${change}!` };
      },
    };
    let drive = onDriveFile(definition, editor);
    let result = await drive.apply({ target: TARGET, change: "edit" }, NO_SLIDES, { id: 7 });

    expect(calls).toEqual([["edit", { fileId: "deck-1" }, 7]]);
    // What the editor retains is kept beside the file it is for.
    expect(result).toEqual({ action: { target: TARGET, change: "edit!" } });

    let slidesHosts: string[] = [];
    let api = { getOutline: vi.fn(async () => { throw new Error("read refused"); }) };
    let drives = host(fileId => {
      slidesHosts.push(fileId);
      return { api: api as never, presentationId: fileId };
    });
    await expect(DRIVE_SLIDES_DEFINITIONS.skipSlides.apply(
      { target: { fileId: "deck-2" }, change: SKIP }, drives, { id: 1 })).rejects.toThrow("read refused");
    expect(slidesHosts).toEqual(["deck-2"]);
    expect(api.getOutline).toHaveBeenCalledWith("deck-2");
  });

  it("refuse a definition that declares references", () => {
    let editor = { name: "slides" as const, mimeType: GOOGLE_SLIDES_MIME_TYPE, noun: "thing", host: () => ({}) };
    let base: ActionDefinition<string, unknown> = {
      kind: { tag: "t", label: "Things" }, autoApprovable: true, delivery: "continue-with-simulation",
      describe: () => ({ title: "Do", description: "", implementsRevert: false }),
      apply: async () => {},
    };
    expect(() => onDriveFile({ ...base, provides: () => [] }, editor)).toThrow("cannot declare references");
    expect(() => onDriveFile({ ...base, dependsOn: () => [] }, editor)).toThrow("cannot declare references");
  });

  it("name the editor and file a record edits, and no other record", () => {
    let edit = { kind: "skipSlides", payload: { target: TARGET, change: SKIP } };
    expect(editedFile(edit)).toEqual({ editor: "slides", target: TARGET });
    expect(editOf("slides", "deck-1", edit)).toEqual({ kind: "skipSlides", payload: SKIP });
    expect(editOf("slides", "deck-2", edit)).toBeUndefined();
    let comment = { kind: "createComment", payload: { fileId: "deck-1", content: "Hi" } };
    expect(editedFile(comment)).toBeUndefined();
    expect(editOf("slides", "deck-1", comment)).toBeUndefined();

    expect(editorOfTag("editSlidesText")).toBe("slides");
    expect(editorOfTag("update-slides")).toBe("slides");
    expect(editorOfTag("driveComments")).toBeUndefined();
    expect(editorOfMimeType(GOOGLE_SLIDES_MIME_TYPE)).toBe("slides");
    expect(editorOfMimeType("application/vnd.google-apps.folder")).toBeUndefined();
    expect(editorOfMimeType(undefined)).toBeUndefined();
    expect(editorMimeType("slides")).toBe(GOOGLE_SLIDES_MIME_TYPE);
  });

  it("join the Drive action set, which lists comments and the presentations' kinds", () => {
    let drive: DriveHost = {
      api: {} as DriveHost["api"], docs: {} as DriveHost["docs"], scope: () => ({ kind: "account" }),
      writeRefusal: async () => undefined, attempts: { get: () => undefined, put() {}, delete() {} },
      ...NO_SLIDES,
    };
    let actions = DRIVE_ACTIONS.bind(new ActionJournal<DriveAction>(new FakeKv(), { namespace: "drive" }), drive);
    expect(actions.autoApprovableKinds()).toEqual(
      [{ tag: "driveComments", label: "Drive comments" }, ...DRIVE_SLIDES_KINDS, ...DRIVE_SHEETS_KINDS, ...DRIVE_DOCS_KINDS]);
  });
});

/** A Drive journal with edits of two presentations, and the gatekeeper side of their edits. */
function editors(options: {
  refusal?: string; file?: (target: DriveEdit<unknown>["target"]) => DriveScopeNode | undefined;
} = {}) {
  let journal = new ActionJournal<DriveAction>(new FakeKv(), { namespace: "drive" });
  let queue = { submitAction: async () => {} };
  let applied: number[] = [];
  let store = fakeDocStore();
  let fileEditors = new DriveFileEditors({
    kv: new FakeKv(),
    sheets: {} as GoogleSheetsApi,
    docs: {} as GoogleDocsApi,
    drive: {
      getFile: () => Promise.reject(new Error("No file is read here.")),
      getScopeNodes: () => Promise.reject(new Error("No scope is read here.")),
    },
    journal,
    submit: async (_queue, name, payload) => {
      let id = journal.allocate({ kind: name, payload } as DriveAction);
      journal.markSubmitted(id);
      return id;
    },
    apply: async id => { applied.push(id); journal.retire(id); },
    reject: async id => { journal.remove(id); },
    writeRefusal: async () => options.refusal,
    locate: async target => options.file ? options.file(target) : {
      id: target.fileId, mimeType: GOOGLE_SLIDES_MIME_TYPE, trashed: false, canEdit: true,
    },
    docStore: () => store,
  });
  let queueSkip = (fileId: string, skipped = true) =>
    fileEditors.slides({ fileId }, queue).queue("skipSlides", async () => ({
      payload: { ...SKIP, skipped }, result: undefined,
    }));
  return { journal, fileEditors, applied, queueSkip };
}

describe("a Drive binding's edits", () => {
  it("number every file's edits from one journal, and keep each file's order to itself", async () => {
    let { journal, fileEditors, applied, queueSkip } = editors();
    await queueSkip("deck-1");
    await queueSkip("deck-2");
    await queueSkip("deck-1", false);
    expect(journal.listUndecided().map(({ id, action }) =>
      [id, (action.payload as DriveEdit<unknown>).target.fileId])).toEqual(
      [[1, "deck-1"], [2, "deck-2"], [3, "deck-1"]]);

    // Deck 2's change waits behind none of its own; deck 1's second waits behind its first.
    await expect(fileEditors.apply(3)).rejects.toThrow(EDIT_OUT_OF_ORDER);
    await fileEditors.apply(2);
    expect(applied).toEqual([2]);

    let read = await fileEditors.slides({ fileId: "deck-1" }, { submitAction: async () => {} })
      .snapshot(async pending => pending.map(({ id, action }) => [id, action.kind]));
    expect(read).toEqual([[1, "skipSlides"], [3, "skipSlides"]]);
    expect(await fileEditors.reject(1)).toEqual({ restart: true });
    await fileEditors.apply(3);
    expect(applied).toEqual([2, 3]);
  });

  it("answer nothing for a record that is no edit", async () => {
    let { journal, fileEditors } = editors();
    let id = journal.allocate({ kind: "createComment", payload: { fileId: "f", content: "Hi" } } as DriveAction);
    expect(fileEditors.apply(id)).toBeUndefined();
    expect(fileEditors.reject(id)).toBeUndefined();
    expect(fileEditors.apply(99)).toBeUndefined();
  });

  it("refuse to queue an edit the binding or the file refuses, before preparing it", async () => {
    for (let [refusal, file, message] of [
      [WRITES_GRANT_MISSING, undefined, WRITES_GRANT_MISSING],
      [undefined, () => undefined, EDIT_OUT_OF_SCOPE],
      [undefined, () => ({ id: "deck-1", mimeType: "application/vnd.google-apps.document", trashed: false, canEdit: true }), EDIT_OUT_OF_SCOPE],
      [undefined, () => ({ id: "deck-1", mimeType: GOOGLE_SLIDES_MIME_TYPE, trashed: true, canEdit: true }), EDIT_IN_TRASH],
      [undefined, () => ({ id: "deck-1", mimeType: GOOGLE_SLIDES_MIME_TYPE, trashed: false }), EDIT_NOT_ALLOWED],
    ] as const) {
      let { journal, fileEditors } = editors({ refusal, file });
      let prepared = false;
      await expect(fileEditors.slides({ fileId: "deck-1" }, { submitAction: async () => {} })
        .queue("skipSlides", async () => {
          prepared = true;
          return { payload: SKIP, result: undefined };
        })).rejects.toThrow(message);
      expect(prepared, message).toBe(false);
      expect(journal.listUndecided(), message).toEqual([]);
    }
  });

  it("leave an edit pending when a later approval may pass the refusal, and fail it for good otherwise", async () => {
    let refusal: string | undefined;
    let node: DriveScopeNode | undefined;
    let { journal, applied, queueSkip } = editors();
    await queueSkip("deck-1");
    // The same journal, under a binding whose refusal and file each step sets.
    let gated = new DriveFileEditors({
      kv: new FakeKv(),
      sheets: {} as GoogleSheetsApi,
      docs: {} as GoogleDocsApi,
      drive: {
        getFile: () => Promise.reject(new Error("No file is read here.")),
        getScopeNodes: () => Promise.reject(new Error("No scope is read here.")),
      },
      journal,
      submit: async () => 0,
      apply: async id => { applied.push(id); journal.retire(id); },
      reject: async id => { journal.remove(id); },
      writeRefusal: async () => refusal,
      locate: async () => node,
      docStore: () => { throw new Error("No Doc is opened here."); },
    });

    for (refusal of [WRITES_GRANT_MISSING, DEPLOYMENT_READ_ONLY]) {
      await expect(gated.apply(1)).rejects.toThrow(refusal);
      expect(journal.get(1)?.state).toBe("pending");
    }
    refusal = undefined;
    node = undefined;
    await expect(gated.apply(1)).rejects.toThrow(EDIT_OUT_OF_SCOPE);
    expect(journal.get(1)).toMatchObject({ state: "failed", error: EDIT_OUT_OF_SCOPE, undispatched: true });
    expect(applied).toEqual([]);
  });
});

describe("a Drive binding's edits, proved again where they apply", () => {
  it("are proved again inside the action set's queue, before the editor writes", async () => {
    let proved: [string, string, number][] = [];
    let written = false;
    let drive: DriveEditorsHost = {
      editors: {
        ...NO_SLIDES.editors,
        slides: fileId => ({ api: {} as SlidesHost["api"], presentationId: fileId }),
        prove: async (editor, target, id) => {
          proved.push([editor, target.fileId, id]);
          // A move approved ahead of it took the file out of the folder.
          throw new ActionApplyError("That file is no longer in this connection's scope.");
        },
      },
    };
    let definition = onDriveFile({
      ...SLIDES_DEFINITIONS.skipSlides,
      apply: async () => { written = true; },
    }, { name: "slides", mimeType: GOOGLE_SLIDES_MIME_TYPE, noun: "presentation",
      host: (host, fileId) => host.editors.slides(fileId) });
    await expect(definition.apply({ target: TARGET, change: SKIP }, drive, { id: 7 }))
      .rejects.toBeInstanceOf(ActionApplyError);
    expect(proved).toEqual([["slides", "deck-1", 7]]);
    expect(written).toBe(false);
  });

  it("leave an edit pending for a refusal a later approval can pass, and fail it otherwise", async () => {
    let node: DriveScopeNode | undefined;
    let { fileEditors } = editors({ file: () => node });
    let gated = editors({ refusal: WRITES_GRANT_MISSING }).fileEditors;
    await expect(gated.prove("slides", TARGET, 1)).rejects.not.toBeInstanceOf(ActionApplyError);
    await expect(gated.prove("slides", TARGET, 1)).rejects.toThrow(WRITES_GRANT_MISSING);
    node = undefined;
    await expect(fileEditors.prove("slides", TARGET, 1)).rejects.toBeInstanceOf(ActionApplyError);
    node = { id: "deck-1", mimeType: GOOGLE_SLIDES_MIME_TYPE, trashed: false, canEdit: true };
    await expect(fileEditors.prove("slides", TARGET, 1)).resolves.toBeUndefined();
  });
});

describe("a Doc edited through Drive, read again after an approval", () => {
  // Another session can queue an edit checked against a newer revision while that read is out:
  // replayed over the older answer, the valid edit would fail for good.
  it("reads again when an edit is queued while the read is out", async () => {
    let revisions: { revisionId: string; text: string }[] = [];
    let release: (() => void) | undefined;
    let reads = 0;
    let docs = {
      getDocument: async () => {
        reads++;
        let { revisionId, text } = revisions[0];
        if (reads === 1) await new Promise<void>(resolve => { release = resolve; });
        return {
          documentId: "doc-1", title: "Plan", revisionId,
          tabs: [{ ...buildTab([{ runs: [`${text}\n`] }]), title: "Main" }],
        };
      },
    } as unknown as GoogleDocsApi;
    let journal = new ActionJournal<DriveAction>(new FakeKv(), { namespace: "drive" });
    // One store, as a connection has: the replay reads the rows the fetch wrote.
    let store = fakeDocStore();
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let fileEditors = new DriveFileEditors({
      kv: new FakeKv(),
      sheets: {} as GoogleSheetsApi,
      docs,
      drive: {
        getFile: () => Promise.reject(new Error("No file is read here.")),
        getScopeNodes: () => Promise.reject(new Error("No scope is read here.")),
      },
      journal,
      submit: async () => { throw new Error("Nothing is submitted here."); },
      apply: async id => { journal.retire(id); },
      reject: async id => { journal.remove(id); },
      writeRefusal: async () => undefined,
      locate: async target => ({
        id: target.fileId, mimeType: GOOGLE_DOC_MIME_TYPE, trashed: false, canEdit: true,
      }),
      docStore: () => store,
    });
    let base = {
      tabId: "tab-1", submittedAt: 0, markdownVersion: MARKDOWN_RENDERING_VERSION, display: { tab: "x" },
    };
    let queue = (change: object) => {
      let id = journal.allocate({ kind: (change as { type: string }).type,
        payload: { target: { fileId: "doc-1" }, change } } as DriveAction);
      journal.markSubmitted(id);
      return id;
    };
    let first = queue({ ...base, type: "appendText", markdown: "One", writeId: "w1" });
    queue({ ...base, type: "appendText", markdown: "Two", writeId: "w2" });

    revisions.push({ revisionId: "r2", text: "Draft\n\nOne" });
    let applying = fileEditors.apply(first);
    await vi.waitFor(() => expect(release).toBeDefined());
    // A collaborator adds text, and another session queues an edit of it against that revision.
    revisions[0] = { revisionId: "r3", text: "Draft\n\nOne\n\nExternal" };
    let replacement = queue({
      ...base, type: "replaceText", oldMarkdown: "External", newMarkdown: "Final", writeId: "w3",
    });
    release!();
    await applying;
    let warned = warn.mock.calls.length;
    warn.mockRestore();

    expect(reads).toBe(2);
    // The replay over the document read again ran, and found the text the edit replaces.
    expect(warned).toBe(0);
    expect(journal.get(replacement)).toMatchObject({ state: "pending" });
  });
});

/** An edit that appends `markdown` to tab `tab-1` of a Doc. */
function appended(markdown: string) {
  return {
    type: "appendText", tabId: "tab-1", submittedAt: 0, markdown, writeId: `w-${markdown}`,
    markdownVersion: MARKDOWN_RENDERING_VERSION, display: { tab: "x" },
  } satisfies GoogleDocAction;
}

describe("a Doc's copy in a Drive binding's store", () => {
  const documentOf = (text: string, revisionId = "r1"): GoogleDocsDocument => ({
    documentId: "doc-1", title: "Plan", revisionId,
    tabs: [{ ...buildTab([{ runs: [`${text}\n`] }]), title: "Main" }],
  });

  /** A binding over one store, with what its journal and its fake Google were asked. */
  function docEditors(options: {
    located?: () => boolean; apply?: (id: number) => Promise<void>;
    docCaps?: { count: number; bytes: number };
  } = {}) {
    let storage = fakeDocStorage();
    let store = new DocStore(storage);
    let asked = 0;
    let fetches = 0;
    let journal = new ActionJournal<DriveAction>(new FakeKv(), { namespace: "drive" });
    let kv = new FakeKv();
    let fileEditors = new DriveFileEditors({
      kv,
      sheets: {} as GoogleSheetsApi,
      docs: {
        getDocument: async () => {
          fetches++;
          return documentOf("Draft", "r2");
        },
      } as unknown as GoogleDocsApi,
      drive: {
        getFile: () => Promise.reject(new Error("No file is read here.")),
        getScopeNodes: () => Promise.reject(new Error("No scope is read here.")),
      },
      journal,
      submit: async () => { throw new Error("Nothing is submitted here."); },
      apply: options.apply ?? (async id => { journal.retire(id); }),
      reject: async id => { journal.remove(id); },
      writeRefusal: async () => undefined,
      locate: async target => options.located?.() === false ? undefined : {
        id: target.fileId, trashed: false, canEdit: true,
        mimeType: target.fileId.startsWith("sheet") ? GOOGLE_SHEET_MIME_TYPE : GOOGLE_DOC_MIME_TYPE,
      },
      docStore: () => {
        asked++;
        return store;
      },
      ...(options.docCaps ? { docCaps: options.docCaps } : {}),
    });
    let queue = (fileId: string, change: object, kind = (change as { type: string }).type) => {
      let id = journal.allocate({ kind, payload: { target: { fileId }, change } } as DriveAction);
      journal.markSubmitted(id);
      return id;
    };
    let append = (fileId: string, markdown: string) => queue(fileId, appended(markdown));
    return {
      storage, store, journal, kv, fileEditors, queue, append,
      asked: () => asked, fetches: () => fetches,
    };
  }

  /** Whether `store` holds, of document `doc`, the version of a tab that reads `text`. */
  function putBeside(store: DocStore, doc: string, text: string) {
    let tab = pruneTab(documentOf(text).tabs[0]);
    let version = store.putTab(doc, tab, []);
    return () => store.version(doc, version.id, version) !== undefined;
  }

  it("keeps a document under its file id, and two files apart", () => {
    let { store, fileEditors } = docEditors();
    let first = fileEditors.docCopies("doc-1").keep(fileEditors.docCopies("doc-1").hold(documentOf("One"), 1));
    let second = fileEditors.docCopies("doc-2").keep(fileEditors.docCopies("doc-2").hold(documentOf("Two"), 2), "folder-1");
    expect(store.head("doc-1")).toMatchObject({ revision: "r1", fetchedAt: 1, stale: false });
    expect(store.head("doc-2")).toMatchObject({ fetchedAt: 2, folder: "folder-1" });
    expect(store.head("doc-1")?.versions).not.toEqual(store.head("doc-2")?.versions);
    expect(first?.stored).toEqual({ store, doc: "doc-1" });
    expect(second?.stored).toEqual({ store, doc: "doc-2" });
    expect(first?.held()).toBe(true);

    // A write to one leaves the other's copy as it was.
    fileEditors.docCopies("doc-1").wrote();
    expect(first?.held()).toBe(false);
    expect(second?.held()).toBe(true);
    expect(store.head("doc-3")).toBeUndefined();
  });

  it("replays after an applied edit in a trial that stores nothing", async () => {
    let { storage, journal, fileEditors, append, fetches } = docEditors();
    let before = storage.rows();
    let first = append("doc-1", "One");
    let second = append("doc-1", "Two");
    await fileEditors.apply(first);
    // The edit left pending was replayed over the document as it reads after the approval.
    expect(fetches()).toBe(1);
    expect(journal.get(second)).toMatchObject({ state: "pending" });
    expect(storage.rows()).toEqual(before);
    expect(storage.openCursors()).toBe(0);
  });

  it("marks a document's stored copy stale where its write lands", () => {
    let { storage, store, fileEditors } = docEditors();
    let cache = fileEditors.docs({ fileId: "doc-1" }, { submitAction: async () => {} }).cache;
    fileEditors.docCopies("doc-1").keep(fileEditors.docCopies("doc-1").hold(documentOf("One"), 1));
    expect(store.head("doc-1")?.stale).toBe(false);
    fileEditors.docsHost("doc-1").landed(7, undefined);
    expect(store.head("doc-1")?.stale).toBe(true);
    expect(cache.writes).toBe(1);

    // A file with no stored copy: the write is counted, and nothing is written.
    let rows = storage.rows();
    fileEditors.docsHost("doc-2").landed(8, undefined);
    expect(fileEditors.docs({ fileId: "doc-2" }, { submitAction: async () => {} }).cache.writes).toBe(1);
    expect(storage.rows()).toEqual(rows);
  });

  it("sweeps a document's rows once an edit of it is approved, and once one is rejected", async () => {
    let failure = new Error("Google refused the batch.");
    let fails = false;
    let { store, journal, fileEditors, queue, append, asked } = docEditors({
      apply: async id => {
        journal.retire(id);
        if (fails) throw failure;
      },
    });
    fileEditors.docCopies("doc-1").keep(fileEditors.docCopies("doc-1").hold(documentOf("Kept"), 1));

    // A version beside the kept copy that no pending edit reaches.
    let stored = putBeside(store, "doc-1", "Unreached");
    expect(stored()).toBe(true);
    await fileEditors.apply(append("doc-1", "One"));
    expect(stored()).toBe(false);

    // An approval that fails its edit for good sweeps too, and its failure is the one thrown.
    stored = putBeside(store, "doc-1", "Unreached");
    fails = true;
    await expect(fileEditors.apply(append("doc-1", "Two"))).rejects.toBe(failure);
    expect(stored()).toBe(false);

    stored = putBeside(store, "doc-1", "Unreached");
    await fileEditors.reject(append("doc-1", "Three"));
    expect(stored()).toBe(false);
    expect(store.head("doc-1")).toMatchObject({ fetchedAt: 1, stale: false });

    // An edit of a spreadsheet asks nothing of the store.
    fails = false;
    let calls = asked();
    await fileEditors.apply(queue("sheet-1", { changes: [] }, "editSheetValues"));
    await fileEditors.reject(queue("sheet-1", { changes: [] }, "editSheetValues"));
    expect(asked()).toBe(calls);
  });

  it("sweeps with the file's pending edits, whose stored results stay until they are decided", async () => {
    let { store, fileEditors, queue } = docEditors();
    let kept = fileEditors.docCopies("doc-1").hold(documentOf("Kept"), 1);
    fileEditors.docCopies("doc-1").keep(kept);
    let base = store.version("doc-1", store.head("doc-1")!.versions[0],
      { ...kept.tabs[0].identity, writeMarkers: [] })!;

    // What a pending edit made in the kept tab, stored under the key the binding's queue gives it.
    let change = appended("One");
    let edit = queue("doc-1", change);
    let made = pruneTab(documentOf("Made").tabs[0]);
    store.putResult(base, docEditKey(change), { requests: [], after: store.putTab("doc-1", made, []) });

    fileEditors.docCopies("doc-1").sweep();
    expect(store.result(base, docEditKey(change))).toBeDefined();

    await fileEditors.reject(edit);
    expect(store.result(base, docEditKey(change))).toBeUndefined();
  });

  it("leaves the copy of a document an edit finds out of scope as it was", async () => {
    let located = true;
    let { storage, store, journal, fileEditors, append } = docEditors({ located: () => located });
    fileEditors.docCopies("doc-1").keep(fileEditors.docCopies("doc-1").hold(documentOf("Kept"), 1), "folder-1");
    let stored = putBeside(store, "doc-1", "Unreached");
    let head = store.head("doc-1");
    let rows = storage.rows();

    located = false;
    let edit = append("doc-1", "One");
    await expect(fileEditors.apply(edit)).rejects.toThrow(EDIT_OUT_OF_SCOPE);
    expect(journal.get(edit)).toMatchObject({ state: "failed", error: EDIT_OUT_OF_SCOPE });
    expect(store.head("doc-1")).toEqual(head);
    expect(storage.rows()).toEqual(rows);
    expect(stored()).toBe(true);
  });

  describe("under the binding's caps", () => {
    const HOUR = 3_600_000;
    /** Keeps a document that says `text` as file `fileId`'s copy, approved at the hour `hour`. */
    function keepAt(fileEditors: DriveFileEditors, fileId: string, hour: number, text = fileId) {
      vi.setSystemTime(hour * HOUR);
      let copies = fileEditors.docCopies(fileId);
      return copies.keep(copies.hold(documentOf(text), hour), "folder-1");
    }
    let info: MockInstance<typeof console.info>;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      info = vi.spyOn(console, "info").mockImplementation(() => {});
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("logs one event for an evicted copy, with the file's id and the cap, and nothing of the document", () => {
      let { store, fileEditors } = docEditors({ docCaps: { count: 1, bytes: Infinity } });
      keepAt(fileEditors, "doc-1", 1, "The text of the first document");
      expect(info).not.toHaveBeenCalled();

      keepAt(fileEditors, "doc-2", 2, "The text of the second document");

      expect(store.head("doc-1")).toBeUndefined();
      expect(store.head("doc-2")).toBeDefined();
      // One line, of these fields and no other: no text, title, tab or folder of the document.
      expect(info.mock.calls).toEqual([[{
        component: "gatekeeper.google.drive.editors", vendorId: "google",
        event: "google.doc.copy.evicted", fileId: "doc-1", reason: "count",
        message: "removed a Google Doc's stored copy",
      }]]);
    });

    it("logs the byte cap as the reason where the bytes are what the keep passed", () => {
      let { fileEditors } = docEditors({ docCaps: { count: 10, bytes: 1 } });
      keepAt(fileEditors, "doc-1", 1);
      keepAt(fileEditors, "doc-2", 2);

      expect(info.mock.calls.map(([line]) => line)).toEqual([
        expect.objectContaining({ event: "google.doc.copy.evicted", fileId: "doc-1", reason: "bytes" }),
      ]);
    });

    it("counts a file as pending from the journal's undecided Doc edits, and no other record", async () => {
      let { store, journal, fileEditors, append, queue } = docEditors({ docCaps: { count: 2, bytes: Infinity } });
      let evicted = () => info.mock.calls.map(([line]) => (line as { fileId: string }).fileId);
      keepAt(fileEditors, "doc-1", 1);
      keepAt(fileEditors, "doc-2", 2);
      // An edit of the first Doc awaits a decision. The second file's id is named by a record
      // of another editor and by a comment, neither of which is an edit of a Doc.
      let edit = append("doc-1", "One");
      queue("doc-2", SKIP, "skipSlides");
      let comment = journal.allocate({ kind: "createComment", payload: { fileId: "doc-2", content: "Hi" } } as DriveAction);
      journal.markSubmitted(comment);

      keepAt(fileEditors, "doc-3", 3);
      // The first copy's approval is the oldest, and it stays for its pending edit.
      expect(evicted()).toEqual(["doc-2"]);
      expect(store.head("doc-1")).toBeDefined();

      // Once its edit is decided it is a file like any other.
      await fileEditors.reject(edit);
      keepAt(fileEditors, "doc-4", 4);
      expect(evicted()).toEqual(["doc-2", "doc-1"]);
      expect(store.copies().map(({ doc }) => doc).toSorted()).toEqual(["doc-3", "doc-4"]);
    });

    // A binding given no caps is brought to the connection's own by its records, which is all
    // the caps read of a copy.
    describe("where it is given none", () => {
      /**
       * Seeds ?1 records of copies beside doc-1's, each of ?2 bytes, with no version, approved
       * an hour after that copy.
       */
      const SEED = `
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
        INSERT INTO doc_copy (doc, id, revision, fetched_at, checked_at, stale, folder, approved,
                              made, bytes, outline, markers, versions)
        SELECT 'seeded-' || i, 'seeded', NULL, c.fetched_at + i, NULL, 0, c.folder,
               c.approved + ${HOUR}, c.made, ?2, '[]', '[]', '[]'
        FROM n, doc_copy AS c WHERE c.doc = 'doc-1'`;

      it("keeps the connection's count of documents, and evicts at one more", () => {
        let { storage, store, fileEditors } = docEditors();
        keepAt(fileEditors, "doc-1", 1);
        storage.sql.exec(SEED, MAX_DRIVE_DOC_COPIES - 2, 0);

        keepAt(fileEditors, "doc-2", 3);
        expect(store.copies()).toHaveLength(MAX_DRIVE_DOC_COPIES);
        expect(info).not.toHaveBeenCalled();

        keepAt(fileEditors, "doc-3", 4);
        expect(info.mock.calls.map(([line]) => line)).toEqual([
          expect.objectContaining({ event: "google.doc.copy.evicted", fileId: "doc-1", reason: "count" }),
        ]);
        expect(store.copies()).toHaveLength(MAX_DRIVE_DOC_COPIES);
      });

      it("keeps the connection's bytes of documents, and evicts at one document more", () => {
        let { storage, store, fileEditors } = docEditors();
        keepAt(fileEditors, "doc-1", 1);
        let [{ bytes }] = store.copies();
        // One record that, with two documents of doc-1's size, is the byte cap to the byte.
        storage.sql.exec(SEED, 1, MAX_DRIVE_DOC_COPY_BYTES - 2 * bytes);

        keepAt(fileEditors, "doc-2", 3);
        expect(store.copies().reduce((sum, copy) => sum + copy.bytes, 0)).toBe(MAX_DRIVE_DOC_COPY_BYTES);
        expect(info).not.toHaveBeenCalled();

        keepAt(fileEditors, "doc-3", 4);
        expect(info.mock.calls.map(([line]) => line)).toEqual([
          expect.objectContaining({ event: "google.doc.copy.evicted", fileId: "doc-1", reason: "bytes" }),
        ]);
        expect(store.copies().map(({ doc }) => doc).toSorted()).toEqual(["doc-2", "doc-3", "seeded-1"]);
      });
    });
  });

  describe("past the binding's expiry", () => {
    const HOUR = 3_600_000, MINUTE = 60_000;
    /** Keeps a document as file `fileId`'s copy, approved at the clock `at`. */
    function keptAt(fileEditors: DriveFileEditors, fileId: string, at: number) {
      vi.setSystemTime(at);
      let copies = fileEditors.docCopies(fileId);
      return copies.keep(copies.hold(documentOf(`The text of ${fileId}`), at), "folder-1");
    }
    let info: MockInstance<typeof console.info>;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      info = vi.spyOn(console, "info").mockImplementation(() => {});
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("the binding's sweep and `tendDocCopies` each run the expiry pass", () => {
      let { store, kv, fileEditors, asked } = docEditors();
      let docs = () => store.copies().map(({ doc }) => doc).toSorted();
      keptAt(fileEditors, "doc-1", HOUR);
      keptAt(fileEditors, "doc-2", 2 * HOUR);
      // The store is asked for once a pass, and for nothing by a call that does not pass.
      let before = asked();

      // Seven days after the first copy's approval: it goes as a session starts.
      vi.setSystemTime(DRIVE_DOC_COPY_EXPIRY_MS + HOUR);
      fileEditors.sweep();
      expect(docs()).toEqual(["doc-2"]);
      expect(asked()).toBe(before + 1);
      expect(kv.get(DOC_COPY_EXPIRY_PASS_KEY)).toBe(DRIVE_DOC_COPY_EXPIRY_MS + HOUR);

      // Neither entry passes again in that hour.
      vi.setSystemTime(DRIVE_DOC_COPY_EXPIRY_MS + HOUR + 59 * MINUTE);
      fileEditors.sweep();
      fileEditors.tendDocCopies();
      expect(asked()).toBe(before + 1);

      // An hour of the clock later, the second goes at a decision's pass.
      vi.setSystemTime(DRIVE_DOC_COPY_EXPIRY_MS + 2 * HOUR);
      fileEditors.tendDocCopies();
      expect(docs()).toEqual([]);
      expect(asked()).toBe(before + 2);
      fileEditors.tendDocCopies();
      fileEditors.sweep();
      expect(asked()).toBe(before + 2);
      expect(kv.get(DOC_COPY_EXPIRY_PASS_KEY)).toBe(DRIVE_DOC_COPY_EXPIRY_MS + 2 * HOUR);
    });

    it("logs one event for an expired copy, with the file's id and the reason, and nothing of the document", () => {
      let { store, fileEditors } = docEditors();
      keptAt(fileEditors, "doc-1", HOUR);
      keptAt(fileEditors, "doc-2", 3 * HOUR);
      fileEditors.tendDocCopies();
      expect(info).not.toHaveBeenCalled();

      vi.setSystemTime(DRIVE_DOC_COPY_EXPIRY_MS + 2 * HOUR);
      fileEditors.tendDocCopies();

      expect(store.head("doc-1")).toBeUndefined();
      expect(store.head("doc-2")).toBeDefined();
      // One line, of these fields and no other: no text, title, tab or folder of the document.
      expect(info.mock.calls).toEqual([[{
        component: "gatekeeper.google.drive.editors", vendorId: "google",
        event: "google.doc.copy.expired", fileId: "doc-1", reason: "unapproved",
        message: "removed a Google Doc's stored copy",
      }]]);
    });
  });
});

describe("whether a folder binding reaches a refused file", () => {
  const FOLDER = "application/vnd.google-apps.folder";
  const folder = (id: string, parent?: string, more: Partial<DriveScopeNode> = {}): DriveScopeNode =>
    ({ id, mimeType: FOLDER, trashed: false, ...(parent === undefined ? {} : { parents: [parent] }), ...more });
  /** A session's saved path: the binding's folder, and a folder inside it the session stands on. */
  const PATH = [folder("root", "above"), folder("sub", "root")];
  const file = (parents?: string[], more: Partial<DriveScopeNode> = {}): DriveScopeNode =>
    ({ id: "doc-1", mimeType: GOOGLE_DOC_MIME_TYPE, trashed: false, ...(parents ? { parents } : {}), ...more });

  it.each<{
    name: string; file: DriveScopeNode | undefined; stood?: string;
    answers?: (DriveScopeNode | undefined)[]; why: string | undefined; asked: string[][];
  }>([
    { name: "a file the account cannot see", file: undefined, why: "invisible", asked: [] },
    { name: "a file in the trash", file: file(["sub"], { trashed: true }), why: "trashed", asked: [] },
    { name: "a file that does not say whether it is in the trash", file: { id: "doc-1", parents: ["sub"] }, why: "trashed", asked: [] },
    { name: "a file with no parent", file: file(), why: "moved-out", asked: [] },
    { name: "a file with two parents", file: file(["sub", "other"]), why: "moved-out", asked: [] },
    { name: "a file whose parent is the binding's folder", file: file(["root"]), why: undefined, asked: [] },
    { name: "a file whose parent is the folder the session stands on", file: file(["sub"]), why: undefined, asked: [] },
    // The file that did not move: it stands where its last allowed read found it, in a folder
    // the refused session never passed through.
    { name: "a file whose parent is where its copy was last read, nowhere on the path", file: file(["deep"]), stood: "deep", why: undefined, asked: [] },
    { name: "a moved file whose parent is directly inside the binding's folder", file: file(["other"]), stood: "sub", answers: [folder("other", "root")], why: undefined, asked: [["other"]] },
    { name: "a moved file whose parent is directly inside a folder further down the path", file: file(["inner"]), stood: "root", answers: [folder("inner", "sub")], why: undefined, asked: [["inner"]] },
    { name: "a moved file whose parent is outside the binding", file: file(["elsewhere"]), stood: "sub", answers: [folder("elsewhere", "above")], why: "moved-out", asked: [["elsewhere"]] },
    // The stated limit: one request does not say what the parent's own parent stands in.
    { name: "a moved file whose parent is two folders away from the path", file: file(["deep"]), stood: "sub", answers: [folder("deep", "other")], why: "moved-out", asked: [["deep"]] },
    { name: "a moved file whose parent Drive does not answer", file: file(["hidden"]), answers: [undefined], why: "moved-out", asked: [["hidden"]] },
    { name: "a moved file whose parent is in the trash", file: file(["other"]), answers: [folder("other", "root", { trashed: true })], why: "moved-out", asked: [["other"]] },
    { name: "a moved file whose parent is on another drive", file: file(["other"]), answers: [folder("other", "root", { driveId: "drive-2" })], why: "moved-out", asked: [["other"]] },
    { name: "a moved file with no copy's folder to compare", file: file(["other"]), answers: [folder("other", "root")], why: undefined, asked: [["other"]] },
  ])("$name: $why", async ({ file: refused, stood, answers = [], why, asked }) => {
    let parents = vi.fn(async (_ids: string[]) => answers);
    expect(await unreachedBy(refused, PATH, stood, parents)).toBe(why);
    expect(parents.mock.calls).toEqual(asked.map(ids => [ids]));
  });
});

describe("a Drive binding told that a folder session was refused a file", () => {
  const HOUR = 3_600_000;
  const FOLDER = "application/vnd.google-apps.folder";
  const PATH: DriveScopeNode[] = [
    { id: "root", mimeType: FOLDER, trashed: false, parents: ["above"] },
    { id: "sub", mimeType: FOLDER, trashed: false, parents: ["root"] },
  ];
  /** The Doc as a refusal reads it once it moved to `parent`. */
  const movedTo = (parent: string, id = "doc-1"): DriveScopeNode =>
    ({ id, mimeType: GOOGLE_DOC_MIME_TYPE, trashed: false, parents: [parent] });
  const ELSEWHERE: DriveScopeNode = { id: "elsewhere", mimeType: FOLDER, trashed: false, parents: ["above"] };
  const documentOf = (text: string, revisionId = "r1"): GoogleDocsDocument => ({
    documentId: "doc", title: "A title no log line holds", revisionId,
    tabs: [{ ...buildTab([{ runs: [`${text}\n`] }]), title: "Main" }],
  });

  /**
   * A binding over a storage of its own, whose store is made only where a Doc is kept or the
   * storage already holds the tables, as a connection's is; with every statement counted and
   * each scope read Drive was asked for.
   */
  function refusedEditors(storage = fakeDocStorage()) {
    let counted = countedStorage(storage);
    let parents = vi.fn(async (_ids: readonly string[]): Promise<(DriveScopeNode | undefined)[]> => [ELSEWHERE]);
    let fileEditors = new DriveFileEditors({
      kv: new FakeKv(),
      sheets: {} as GoogleSheetsApi,
      docs: {} as GoogleDocsApi,
      drive: {
        getFile: () => Promise.reject(new Error("No file is read here.")),
        getScopeNodes: parents,
      },
      journal: new ActionJournal<DriveAction>(new FakeKv(), { namespace: "drive" }),
      submit: async () => { throw new Error("Nothing is submitted here."); },
      apply: async () => {},
      reject: async () => {},
      writeRefusal: async () => undefined,
      locate: async () => undefined,
      docStore: lazyDocStore(counted.storage),
    });
    /** Keeps a document that says `text` as `fileId`'s copy, read under `under` at the clock. */
    let keep = (fileId: string, under: string, text = `The text of ${fileId}`, revision = "r1") => {
      let copies = fileEditors.docCopies(fileId);
      return copies.keep(copies.hold(documentOf(text, revision), Date.now()), under);
    };
    let tables = () => storage.sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'doc\\_%' ESCAPE '\\'",
    ).toArray().map(({ name }) => name);
    return { storage, counted, parents, fileEditors, keep, tables, store: () => new DocStore(storage) };
  }

  let info: MockInstance<typeof console.info>;
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(HOUR);
    info = vi.spyOn(console, "info").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("asks nothing where no copy is stored", async () => {
    let { storage, parents, fileEditors, keep } = refusedEditors();
    keep("doc-2", "sub");
    let rows = storage.rows();

    await fileEditors.docRefused("doc-1", movedTo("elsewhere"), PATH);
    await fileEditors.docRefused("doc-1", undefined, PATH);

    expect(parents).not.toHaveBeenCalled();
    expect(storage.rows()).toEqual(rows);
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("removes the copy and logs one event", async () => {
    let { storage, parents, fileEditors, keep, store } = refusedEditors();
    keep("doc-2", "sub");
    // What a connection that never read the file stores.
    let without = storage.rows();
    keep("doc-1", "sub", "Text that no log line holds");
    expect(storage.rows()).not.toEqual(without);

    await fileEditors.docRefused("doc-1", movedTo("elsewhere"), PATH);

    // One request, for the file's parent folder and nothing else.
    expect(parents.mock.calls).toEqual([[["elsewhere"]]]);
    expect(store().head("doc-1")).toBeUndefined();
    expect(storage.rows()).toEqual(without);
    // One line, of these fields and no other: no text, title, tab or folder of the document.
    expect(info.mock.calls).toEqual([[{
      component: "gatekeeper.google.drive.editors", vendorId: "google",
      event: "google.doc.copy.unreachable", fileId: "doc-1", reason: "moved-out",
      message: "removed a Google Doc's stored copy",
    }]]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    { reason: "invisible", file: undefined },
    { reason: "trashed", file: { ...movedTo("sub"), trashed: true } },
  ])("removes the copy of a file that is $reason with nothing asked", async ({ reason, file }) => {
    let { parents, fileEditors, keep, store } = refusedEditors();
    keep("doc-1", "sub");

    await fileEditors.docRefused("doc-1", file, PATH);

    expect(parents).not.toHaveBeenCalled();
    expect(store().head("doc-1")).toBeUndefined();
    expect(info.mock.calls.map(([line]) => line)).toEqual([
      expect.objectContaining({ event: "google.doc.copy.unreachable", fileId: "doc-1", reason }),
    ]);
  });

  it("keeps the copy of a file that stands where it was last read, with nothing asked", async () => {
    let { storage, parents, fileEditors, keep } = refusedEditors();
    // Read under a folder the refused session's path does not name.
    keep("doc-1", "deep");
    let rows = storage.rows();

    await fileEditors.docRefused("doc-1", movedTo("deep"), PATH);

    expect(parents).not.toHaveBeenCalled();
    expect(storage.rows()).toEqual(rows);
    expect(info).not.toHaveBeenCalled();
  });

  it.each<{ name: string; meanwhile(keep: ReturnType<typeof refusedEditors>["keep"], fileEditors: DriveFileEditors): void }>([
    { name: "fetched", meanwhile: keep => { vi.setSystemTime(HOUR + 1); keep("doc-1", "sub", "A later text", "r2"); } },
    { name: "approved under another folder", meanwhile: (_keep, fileEditors) => fileEditors.docCopies("doc-1").approvedUnder("other") },
    {
      name: "approved in another hour",
      meanwhile: (_keep, fileEditors) => {
        vi.setSystemTime(2 * HOUR);
        fileEditors.docCopies("doc-1").approvedUnder("sub");
      },
    },
  ])("keeps a copy another read $name while Drive was asked", async ({ meanwhile }) => {
    let { storage, parents, fileEditors, keep } = refusedEditors();
    keep("doc-1", "sub");
    let rows: ReturnType<typeof storage.rows> | undefined;
    parents.mockImplementation(async () => {
      meanwhile(keep, fileEditors);
      rows = storage.rows();
      return [ELSEWHERE];
    });

    await fileEditors.docRefused("doc-1", movedTo("elsewhere"), PATH);

    expect(parents).toHaveBeenCalledTimes(1);
    expect(rows).toBeDefined();
    expect(storage.rows()).toEqual(rows);
    expect(info).not.toHaveBeenCalled();
  });

  it("removes a copy approved again in the same hour under the same folder while Drive was asked, which the record cannot show", async () => {
    let { parents, fileEditors, keep, store } = refusedEditors();
    keep("doc-1", "sub");
    let head = store().head("doc-1");
    parents.mockImplementation(async () => {
      // A second allowed read of the same copy, minutes later: its record is written once an
      // hour and a folder, so this approval leaves it as it was.
      vi.setSystemTime(HOUR + 59 * 60_000);
      fileEditors.docCopies("doc-1").approvedUnder("sub");
      expect(store().head("doc-1")).toEqual(head);
      return [ELSEWHERE];
    });

    await fileEditors.docRefused("doc-1", movedTo("elsewhere"), PATH);

    // The copy goes, and the file's next allowed read fetches once.
    expect(store().head("doc-1")).toBeUndefined();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("keeps the copy and logs a warning when the lookup fails", async () => {
    let { storage, parents, fileEditors, keep } = refusedEditors();
    keep("doc-1", "sub");
    let rows = storage.rows();
    let failure = new Error("Drive is down.");
    parents.mockRejectedValue(failure);

    await expect(fileEditors.docRefused("doc-1", movedTo("elsewhere"), PATH)).resolves.toBeUndefined();

    expect(storage.rows()).toEqual(rows);
    expect(info).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(([line]) => line)).toEqual([expect.objectContaining({
      component: "gatekeeper.google.drive.editors", event: "google.doc.copy.reach.failed",
      fileId: "doc-1",
    })]);
    // The line names the failure and nothing of the document or its folders.
    expect(JSON.stringify(warn.mock.calls)).toContain("Drive is down.");
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/elsewhere|sub|The text of/);
  });

  it("never throws", async () => {
    let { storage, fileEditors, keep, store } = refusedEditors();
    keep("doc-1", "sub");

    // Storage refuses the read of the copy's record.
    storage.refuse(statement => statement.includes("FROM doc_copy WHERE doc = ?"));
    await expect(fileEditors.docRefused("doc-1", movedTo("elsewhere"), PATH)).resolves.toBeUndefined();
    // Storage refuses a write in the middle of the drop, which is undone whole.
    storage.refuse(statement => statement.startsWith("DELETE FROM doc_run"));
    await expect(fileEditors.docRefused("doc-1", movedTo("elsewhere"), PATH)).resolves.toBeUndefined();
    storage.refuse(undefined);

    expect(store().head("doc-1")).toBeDefined();
    expect(info).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(([line]) => (line as { event: string }).event)).toEqual([
      "google.doc.copy.reach.failed", "google.doc.copy.reach.failed",
    ]);
  });

  describe("of a spreadsheet or a folder", () => {
    const REFUSED: [string, DriveScopeNode][] = [
      ["sheet-1", { ...movedTo("elsewhere", "sheet-1"), mimeType: GOOGLE_SHEET_MIME_TYPE }],
      ["folder-1", { ...movedTo("elsewhere", "folder-1"), mimeType: FOLDER }],
    ];

    it("a refused spreadsheet or folder asks Drive nothing and makes no table", async () => {
      let { counted, parents, fileEditors, tables } = refusedEditors();

      for (let [index, [id, node]] of REFUSED.entries()) {
        await fileEditors.docRefused(id, node, PATH);
        // One statement a refusal, the one over the storage's schema.
        expect(counted.counts().all).toBe(index + 1);
      }

      expect(parents).not.toHaveBeenCalled();
      expect(counted.ran()).toEqual([
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'doc_copy'",
      ]);
      expect(tables()).toEqual([]);
    });

    it("a refused spreadsheet or folder reads one record by its key where the storage holds a Doc, and asks Drive nothing", async () => {
      let { storage, counted, parents, fileEditors, keep } = refusedEditors();
      keep("doc-1", "sub");
      let rows = storage.rows();
      // Each statement as storage is handed it, with what it is bound to; none is refused.
      let ran: { statement: string; bindings: unknown[] }[] = [];
      storage.refuse((statement, bindings) => {
        ran.push({ statement: statement.replace(/\s+/g, " "), bindings: [...bindings] });
        return false;
      });

      for (let [id, node] of REFUSED) {
        let before = counted.counts().all, read = counted.rowsRead(), written = counted.rowsWritten();
        await fileEditors.docRefused(id, node, PATH);
        expect(counted.counts().all - before).toBe(1);
        // A Durable Object's storage bills the row; this storage does not say what it read.
        expect(counted.rowsRead() - read).toBeLessThanOrEqual(1);
        expect(counted.rowsWritten() - written).toBe(0);
      }
      storage.refuse(undefined);

      // One statement a refusal: the search of the copy's record by the refused id, which
      // scans no table.
      expect(ran.map(({ bindings }) => bindings)).toEqual([["sheet-1"], ["folder-1"]]);
      expect(new Set(ran.map(({ statement }) => statement)).size).toBe(1);
      expect(ran[0].statement).toMatch(/^SELECT id, .* FROM doc_copy WHERE doc = \?$/);
      expect(storage.plan(ran[0].statement)).toEqual(["SEARCH doc_copy USING PRIMARY KEY (doc=?)"]);
      expect(parents).not.toHaveBeenCalled();
      expect(storage.rows()).toEqual(rows);
    });
  });
});
