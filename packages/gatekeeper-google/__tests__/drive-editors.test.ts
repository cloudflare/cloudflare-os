import { ActionApplyError, ActionJournal, type ActionDefinition } from "@gadgets/gatekeeper-kit/actions";
import { describe, expect, it, vi } from "vitest";
import { DRIVE_ACTIONS, type DriveAction, type DriveHost } from "../src/drive-actions";
import type { DriveScopeNode } from "../src/drive-api";
import {
  DRIVE_SLIDES_DEFINITIONS, DriveFileEditors, editedFile, editOf, editorMimeType, editorOfMimeType,
  editorOfTag, EDIT_IN_TRASH, EDIT_NOT_ALLOWED, EDIT_OUT_OF_ORDER, EDIT_OUT_OF_SCOPE, onDriveFile,
  type DriveEdit, type DriveEditorsHost,
} from "../src/drive-editors";
import { GOOGLE_SLIDES_MIME_TYPE } from "../src/drive-session";
import { DEPLOYMENT_READ_ONLY, WRITES_GRANT_MISSING } from "../src/drive-writes";
import { SLIDES_DEFINITIONS, type SlidesHost } from "../src/slides-actions";
import type { SlidesActions } from "../src/slides-simulation";
import { DRIVE_SHEETS_KINDS, DRIVE_SLIDES_KINDS } from "./drive-edit-kinds";
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
      [{ tag: "driveComments", label: "Drive comments" }, ...DRIVE_SLIDES_KINDS, ...DRIVE_SHEETS_KINDS]);
  });
});

/** A Drive journal with edits of two presentations, and the gatekeeper side of their edits. */
function editors(options: {
  refusal?: string; file?: (target: DriveEdit<unknown>["target"]) => DriveScopeNode | undefined;
} = {}) {
  let journal = new ActionJournal<DriveAction>(new FakeKv(), { namespace: "drive" });
  let queue = { submitAction: async () => {} };
  let applied: number[] = [];
  let fileEditors = new DriveFileEditors({
    kv: new FakeKv(),
    sheets: {} as GoogleSheetsApi,
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
      journal,
      submit: async () => 0,
      apply: async id => { applied.push(id); journal.retire(id); },
      reject: async id => { journal.remove(id); },
      writeRefusal: async () => refusal,
      locate: async () => node,
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
