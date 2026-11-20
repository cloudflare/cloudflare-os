import { describe, expect, it, vi } from "vitest";
import {
  ConfluenceStore,
  applyStoredAction,
  autoApprovableKinds,
  rejectStoredAction,
  revertStoredAction,
  stageAction,
  type ConfluenceAction,
  type UploadAttachmentAction,
} from "../src/confluence-actions";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { ConfluenceUnnamedCreationError, type ConfluenceApi } from "../src/confluence-api";

type Storage = ConstructorParameters<typeof ConfluenceStore>[0];

// Minimal in-memory storage matching the slice of the DO storage API the store uses.
function makeStorage(): Storage {
  const map = new Map<string, unknown>();
  const kv = {
    get: <T>(k: string) => {
      const value = map.get(k);
      return value === undefined ? undefined : structuredClone(value) as T;
    },
    put: (k: string, v: unknown) => void map.set(k, structuredClone(v)),
    delete: (k: string) => void map.delete(k),
    list: <T>({ prefix }: { prefix: string }) =>
      [...map.entries()].filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => [key, structuredClone(value)] as [string, T]),
  };
  return {
    kv,
    transactionSync: <T>(callback: () => T): T => callback(),
  } as unknown as Storage;
}

type Recorded = {
  addComment: { id: string; type: string }[];
  updateContent: { title: string; status?: string }[];
  uploadAttachment: { id: string; filename: string; data: Uint8Array }[];
};

// Fake API recording the calls apply/revert make. `contentType` controls what getContentById reports;
// `status` controls whether the target page reads back as a draft or a published ("current") page.
function makeApi(contentType: "page" | "blogpost" = "page", status: string = "current") {
  const calls: Recorded = { addComment: [], updateContent: [], uploadAttachment: [] };
  const api = {
    getContentById: async (id: string) => ({
      id, type: contentType, status, title: "Title", version: { number: 3 },
      body: { storage: { value: "<p>body</p>" } },
      _links: { webui: "/spaces/ENG/pages/" + id },
    }),
    updateContent: async (b: { title: string; status?: string }) => { calls.updateContent.push(b); return {}; },
    addComment: async (id: string, _storage: string, type: string) => {
      calls.addComment.push({ id, type });
      return { id: "comment-1" };
    },
    trashContent: async () => {},
    restoreContent: async () => {},
    deleteComment: async () => {},
    deleteAttachment: async () => {},
    uploadAttachment: async (id: string, file: {filename: string; data: Uint8Array}) => {
      calls.uploadAttachment.push({id, filename: file.filename, data: file.data.slice()});
      return {id: "attachment-1"};
    },
  } as unknown as ConfluenceApi;
  return { api, calls };
}

function storeWith(api: ConfluenceApi) {
  return new ConfluenceStore(makeStorage(), api);
}

function stage(store: ConfluenceStore, action: ConfluenceAction): number {
  const id = store.nextActionId();
  store.putAction({ id, action, state: "pending", submittedAt: id });
  return id;
}

async function uploadAction(
  store: ConfluenceStore, data: Uint8Array, contentId = "123",
): Promise<UploadAttachmentAction> {
  return {
    type: "uploadAttachment", contentId, filename: "example.bin",
    mediaType: "application/octet-stream", file: await store.captureAttachment(data),
  };
}

describe("applyStoredAction", () => {
  it("marks the action applied so reads stop overlaying it", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const id = stage(store, { type: "setTitle", contentId: "123", title: "New", previousTitle: "Title" });

    await applyStoredAction(store, id);

    expect(store.getAction(id)?.state).toBe("applied");
    expect(store.pendingActions()).toHaveLength(0);
    expect(store.pendingForContent("123")).toHaveLength(0);
  });

  it("posts blog-post comments with a blogpost container type", async () => {
    const { api, calls } = makeApi("blogpost");
    const store = storeWith(api);
    const id = stage(store, { type: "addComment", contentId: "555", text: "hi" });

    await applyStoredAction(store, id);

    expect(calls.addComment).toEqual([{ id: "555", type: "blogpost" }]);
  });

  it("posts page comments with a page container type", async () => {
    const { api, calls } = makeApi("page");
    const store = storeWith(api);
    const id = stage(store, { type: "addComment", contentId: "555", text: "hi" });

    await applyStoredAction(store, id);

    expect(calls.addComment).toEqual([{ id: "555", type: "page" }]);
  });

  it("sends a creation once where Confluence answers it without naming what it made, and says the outcome is unknown", async () => {
    const { api, calls } = makeApi("page");
    // The comment may have been made: its POST was answered a success that names nothing.
    const unnamed = new ConfluenceUnnamedCreationError("comment");
    api.addComment = async (id: string, _storage: string, type: string) => {
      calls.addComment.push({ id, type });
      throw unnamed;
    };
    const store = storeWith(api);
    const id = stage(store, { type: "addComment", contentId: "555", text: "hi" });

    const first = await applyStoredAction(store, id).catch((error: unknown) => error);
    const second = await applyStoredAction(store, id).catch((error: unknown) => error);

    expect(first).toMatchObject({ message: expect.stringContaining("may or may not have been made"), cause: unnamed });
    expect(second).toMatchObject({ message: expect.stringContaining("may or may not have been made") });
    // No second POST: the action stays pending, to be discarded.
    expect(calls.addComment).toHaveLength(1);
    expect(store.getAction(id)).toMatchObject({ state: "pending", outcomeUnknown: expect.any(String) });
    // It is kept for that guard and for its discard, and no read simulates it any more: the
    // comment may be in Confluence already, where a read finds it.
    expect(store.pendingActions().map(record => record.id)).toEqual([id]);
    expect(store.simulatedActions()).toEqual([]);
    expect(store.pendingForContent("555")).toEqual([]);
    rejectStoredAction(store, id);
    expect(store.getAction(id)).toBeUndefined();
  });

  it("sends a creation again after a failure that says it was not made", async () => {
    const { api, calls } = makeApi("page");
    let failed = false;
    const add = api.addComment.bind(api);
    api.addComment = async (...args: Parameters<ConfluenceApi["addComment"]>) => {
      if (failed) return add(...args);
      failed = true;
      throw new Error("service unavailable");
    };
    const store = storeWith(api);
    const id = stage(store, { type: "addComment", contentId: "555", text: "hi" });

    await expect(applyStoredAction(store, id)).rejects.toThrow("service unavailable");
    await applyStoredAction(store, id);

    expect(calls.addComment).toHaveLength(1);
    expect(store.getAction(id)).toMatchObject({ state: "applied" });
  });

  it("keeps a draft page a draft when editing its content (does not publish it)", async () => {
    const { api, calls } = makeApi("page", "draft");
    const store = storeWith(api);
    const id = stage(store, { type: "setContent", contentId: "123", markdown: "new", previousMarkdown: "old" });

    await applyStoredAction(store, id);

    expect(calls.updateContent).toHaveLength(1);
    expect(calls.updateContent[0].status).toBe("draft");
  });

  it("publishes edits to a current page as current", async () => {
    const { api, calls } = makeApi("page", "current");
    const store = storeWith(api);
    const id = stage(store, { type: "setContent", contentId: "123", markdown: "new", previousMarkdown: "old" });

    await applyStoredAction(store, id);

    expect(calls.updateContent[0].status).toBe("current");
  });

  it("reassembles attachment bytes, uploads once across a retried apply, and releases the file", async () => {
    const { api, calls } = makeApi();
    const store = storeWith(api);
    const data = Uint8Array.from([0, 1, 127, 128, 255]);
    const action = await uploadAction(store, data);
    const id = stage(store, action);

    await applyStoredAction(store, id);
    await applyStoredAction(store, id);

    expect(calls.uploadAttachment).toEqual([{ id: "123", filename: "example.bin", data }]);
    expect(store.getAction(id)).toMatchObject({ state: "applied", createdAttachmentId: "attachment-1" });
    await expect(store.readAttachment(action)).rejects.toThrow(/incomplete or corrupted/);
  });

  it("retains attachment bytes after a retryable upload failure", async () => {
    const { api } = makeApi();
    api.uploadAttachment = async () => { throw new Error("temporary failure"); };
    const store = storeWith(api);
    const data = Uint8Array.from([1, 2, 3]);
    const action = await uploadAction(store, data);
    const id = stage(store, action);

    await expect(applyStoredAction(store, id)).rejects.toThrow("temporary failure");

    expect(store.getAction(id)?.state).toBe("pending");
    await expect(store.readAttachment(action)).resolves.toEqual(data);
  });

  it("applies records queued before attachments moved to the chunk store", async () => {
    const { api, calls } = makeApi();
    const store = storeWith(api);
    const data = Uint8Array.from([4, 5, 6]);
    const id = stage(store, {
      type: "uploadAttachment", contentId: "123", filename: "legacy.bin",
      mediaType: "application/octet-stream", data,
    } as unknown as ConfluenceAction);

    await applyStoredAction(store, id);

    expect(calls.uploadAttachment).toEqual([{ id: "123", filename: "legacy.bin", data }]);
    expect(store.getAction(id)?.state).toBe("applied");
  });
});

describe("staging an action", () => {
  it("refuses one beneath a page queued under a creation whose outcome is unknown, and simulates none of them", async () => {
    const { api } = makeApi();
    api.createPage = async () => { throw new ConfluenceUnnamedCreationError("page"); };
    const store = storeWith(api);
    store.getSpaceId = async () => "10";
    const page = (provisionalId: string, parent: object) => ({
      type: "createContent", kind: "page", provisionalId, title: provisionalId, status: "current", parent,
    }) as ConfluenceAction;
    const parent = stage(store, page("~1", { type: "space", spaceKey: "ENG" }));
    // A child queued while its parent could still be created.
    const child = stage(store, page("~2", { type: "page", parentId: "~1", spaceKey: "ENG" }));
    const comment = stage(store, { type: "addComment", contentId: "~2", text: "hi" });
    await applyStoredAction(store, parent).catch(() => undefined);
    const submitted: number[] = [];
    const queue = { submitAction: async (id: number) => void submitted.push(id) };

    await expect(stageAction(store, queue as never, page("~3", { type: "page", parentId: "~2", spaceKey: "ENG" })))
      .rejects.toThrow("whether it exists is unknown");
    await expect(stageAction(store, queue as never, { type: "addComment", contentId: "~2", text: "more" }))
      .rejects.toThrow("whether it exists is unknown");

    expect(submitted).toEqual([]);
    // The records stay for their discard, and no read shows what can never be applied.
    expect(store.pendingActions().map(record => record.id)).toEqual([parent, child, comment]);
    expect(store.simulatedActions()).toEqual([]);
    expect(store.pendingForContent("~2")).toEqual([]);
    rejectStoredAction(store, parent);
    expect(store.pendingActions()).toEqual([]);
  });

  it("reads no action of the store for one on content that has a real ID", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const pending = vi.spyOn(store, "pendingActions");
    const queue = { submitAction: async () => {} };

    await stageAction(store, queue as never, { type: "addComment", contentId: "555", text: "hi" });
    await stageAction(store, queue as never, {
      type: "createContent", provisionalId: "~1", kind: "page", title: "Top", status: "current",
      parent: { type: "space", spaceKey: "ENG" },
    } as ConfluenceAction);

    expect(pending).not.toHaveBeenCalled();
  });

  it("refuses one on content whose creation's outcome is unknown, and queues nothing", async () => {
    const { api } = makeApi();
    api.createPage = async () => { throw new ConfluenceUnnamedCreationError("page"); };
    const store = storeWith(api);
    store.getSpaceId = async () => "10";
    const parent = stage(store, {
      type: "createContent", kind: "page", provisionalId: "~1", title: "Parent", status: "current",
      parent: { type: "space", spaceKey: "ENG" },
    } as ConfluenceAction);
    await applyStoredAction(store, parent).catch(() => undefined);
    const submitted: number[] = [];
    const queue = { submitAction: async (id: number) => void submitted.push(id) };

    // A page beneath it, and an action on it: neither could ever be applied.
    await expect(stageAction(store, queue as never, {
      type: "createContent", kind: "page", provisionalId: "~2", title: "Child", status: "current",
      parent: { type: "page", parentId: "~1", spaceKey: "ENG" },
    } as ConfluenceAction)).rejects.toThrow("whether it exists is unknown");
    await expect(stageAction(store, queue as never, { type: "addComment", contentId: "~1", text: "hi" }))
      .rejects.toThrow("whether it exists is unknown");

    expect(submitted).toEqual([]);
    expect(store.pendingActions().map(record => record.id)).toEqual([parent]);
    // Content the unknown creation has nothing to do with is queued as ever.
    await stageAction(store, queue as never, { type: "addComment", contentId: "555", text: "hi" });
    expect(submitted).toHaveLength(1);
  });

  it("keeps one applied before a lost submit reply, and reports it submitted", async () => {
    const { api, calls } = makeApi();
    const store = storeWith(api);
    // An auto-approval applies the action before the reply, which then never arrives.
    const queue = { submitAction: async (id: number) => {
      await applyStoredAction(store, id);
      throw new Error("Network connection lost.");
    } };

    const id = await stageAction(store, queue as never, { type: "addComment", contentId: "555", text: "hi" });

    expect(calls.addComment).toHaveLength(1);
    expect(store.getAction(id)?.state).toBe("applied");
  });

  it("keeps one whose apply failed before a lost submit reply, for a retry", async () => {
    const { api } = makeApi();
    api.addComment = async () => { throw new Error("temporary failure"); };
    const store = storeWith(api);
    const queue = { submitAction: async (id: number) => {
      await applyStoredAction(store, id).catch(() => {});
      throw new Error("Network connection lost.");
    } };

    const id = await stageAction(store, queue as never, { type: "addComment", contentId: "555", text: "hi" });

    expect(store.getAction(id)?.state).toBe("pending");
  });
});

describe("attachment files", () => {
  it("are deleted when approval submission fails", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const action = await uploadAction(store, Uint8Array.from([1, 2, 3]));
    const queue = { submitAction: async () => { throw new Error("submission failed"); } };

    await expect(stageAction(store, queue as never, action)).rejects.toThrow("submission failed");

    expect(store.getAction(1)).toBeUndefined();
    await expect(store.readAttachment(action)).rejects.toThrow(/incomplete or corrupted/);
  });

  it("are deleted when an upload's outcome becomes unknown, and the record kept for its discard", async () => {
    const { api, calls } = makeApi();
    api.uploadAttachment = async (id: string, file: { filename: string; data: Uint8Array }) => {
      calls.uploadAttachment.push({ id, filename: file.filename, data: file.data.slice() });
      throw new ConfluenceUnnamedCreationError("attachment");
    };
    const store = storeWith(api);
    const action = await uploadAction(store, Uint8Array.from([1, 2, 3]));
    const id = stage(store, action);

    await expect(applyStoredAction(store, id)).rejects.toThrow("may or may not have been made");

    expect(calls.uploadAttachment).toHaveLength(1);
    expect(store.getAction(id)).toMatchObject({ state: "pending", outcomeUnknown: expect.any(String) });
    await expect(store.readAttachment(action)).rejects.toThrow(/incomplete or corrupted/);
    rejectStoredAction(store, id);
    expect(store.getAction(id)).toBeUndefined();
  });

  it("are deleted where they were queued beneath a creation whose outcome becomes unknown", async () => {
    const { api } = makeApi();
    api.createPage = async () => { throw new ConfluenceUnnamedCreationError("page"); };
    const store = storeWith(api);
    store.getSpaceId = async () => "10";
    const parent = stage(store, {
      type: "createContent", provisionalId: "~parent", kind: "page",
      parent: { type: "space", spaceKey: "ENG" }, title: "Parent", status: "current",
    });
    stage(store, {
      type: "createContent", provisionalId: "~child", kind: "page",
      parent: { type: "page", parentId: "~parent", spaceKey: "ENG" }, title: "Child", status: "current",
    });
    const onChild = await uploadAction(store, Uint8Array.from([1]), "~child");
    const elsewhere = await uploadAction(store, Uint8Array.from([2]), "555");
    stage(store, onChild);
    stage(store, elsewhere);

    await applyStoredAction(store, parent).catch(() => undefined);

    await expect(store.readAttachment(onChild)).rejects.toThrow(/incomplete or corrupted/);
    // An upload to content that exists keeps its bytes for its apply.
    await expect(store.readAttachment(elsewhere)).resolves.toEqual(Uint8Array.from([2]));
    expect(store.pendingActions()).toHaveLength(4);
  });

  it("are deleted when staging refuses an upload to a page whose creation's outcome is unknown", async () => {
    const { api } = makeApi();
    api.createPage = async () => { throw new ConfluenceUnnamedCreationError("page"); };
    const store = storeWith(api);
    store.getSpaceId = async () => "10";
    const parent = stage(store, {
      type: "createContent", provisionalId: "~parent", kind: "page",
      parent: { type: "space", spaceKey: "ENG" }, title: "Parent", status: "current",
    });
    await applyStoredAction(store, parent).catch(() => undefined);
    const action = await uploadAction(store, Uint8Array.from([1, 2, 3]), "~parent");
    const queue = { submitAction: async () => {} };

    await expect(stageAction(store, queue as never, action)).rejects.toThrow("whether it exists is unknown");

    // No record was made of the upload, so nothing else would release its bytes.
    expect(store.pendingActions().map(record => record.id)).toEqual([parent]);
    await expect(store.readAttachment(action)).rejects.toThrow(/incomplete or corrupted/);
  });

  it("are deleted on direct and cascaded rejection", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const direct = await uploadAction(store, Uint8Array.from([1]));
    rejectStoredAction(store, stage(store, direct));

    const createId = stage(store, {
      type: "createContent", provisionalId: "~parent", kind: "page",
      parent: { type: "space", spaceKey: "ENG" }, title: "Parent", status: "current",
    });
    const cascaded = await uploadAction(store, Uint8Array.from([2]), "~parent");
    stage(store, cascaded);
    expect(rejectStoredAction(store, createId)).toEqual({ restart: true });

    await expect(store.readAttachment(direct)).rejects.toThrow(/incomplete or corrupted/);
    await expect(store.readAttachment(cascaded)).rejects.toThrow(/incomplete or corrupted/);
  });

  it("are swept on the next capture once stale and unreferenced by a pending action", async () => {
    const { api } = makeApi();
    const storage = makeStorage();
    const store = new ConfluenceStore(storage, api);
    const referenced = await uploadAction(store, Uint8Array.from([1]));
    stage(store, referenced);
    const orphan = await uploadAction(store, Uint8Array.from([2]));
    for (const [key, value] of storage.kv.list<{ createdAt: number }>({ prefix: "confluence:actionFileAllocation:" })) {
      if (typeof value === "object") storage.kv.put(key, { ...value, createdAt: 0 });
    }

    await store.captureAttachment(Uint8Array.from([3]));

    await expect(store.readAttachment(referenced)).resolves.toEqual(Uint8Array.from([1]));
    await expect(store.readAttachment(orphan)).rejects.toThrow(/incomplete or corrupted/);
  });
});

describe("auto-approval", () => {
  // The description each action type submits, captured from stageAction.
  async function submitted(build: (store: ConfluenceStore) => Promise<ConfluenceAction> | ConfluenceAction) {
    const { api } = makeApi();
    const store = storeWith(api);
    const descriptions: ActionDescription[] = [];
    const queue = { submitAction: async (_id: number, d: ActionDescription) => { descriptions.push(d); } };
    await stageAction(store, queue as never, await build(store));
    return { tag: descriptions[0]?.actionKind?.tag, autoApprovable: descriptions[0]?.autoApprovable };
  }

  const cases: [string, (store: ConfluenceStore) => Promise<ConfluenceAction> | ConfluenceAction, string, boolean][] = [
    ["createContent", () => ({
      type: "createContent", provisionalId: "~new", kind: "page",
      parent: { type: "space", spaceKey: "ENG" }, title: "New", status: "current",
    }), "confluence.createContent", true],
    ["setContent", () => ({ type: "setContent", contentId: "123", markdown: "b", previousMarkdown: "a" }),
      "confluence.editContent", true],
    ["appendContent", () => ({ type: "appendContent", contentId: "123", markdown: "more" }),
      "confluence.editContent", true],
    ["setTitle", () => ({ type: "setTitle", contentId: "123", title: "New", previousTitle: "Old" }),
      "confluence.setTitle", true],
    ["addComment", () => ({ type: "addComment", contentId: "123", text: "hi" }), "confluence.addComment", true],
    ["addLabel", () => ({ type: "addLabel", contentId: "123", name: "x" }), "confluence.label", true],
    ["removeLabel", () => ({ type: "removeLabel", contentId: "123", name: "x" }), "confluence.label", true],
    ["uploadAttachment", store => uploadAction(store, Uint8Array.from([1])), "confluence.uploadAttachment", true],
    ["trash", () => ({ type: "trash", contentId: "123" }), "confluence.trash", false],
    ["restore", () => ({ type: "restore", contentId: "123" }), "confluence.restore", true],
  ];

  it.each(cases)("submits %s with its kind and verdict", async (_type, build, tag, autoApprovable) => {
    expect(await submitted(build)).toEqual({ tag, autoApprovable });
  });

  it("lists exactly the auto-approvable kinds, each once, never trash", () => {
    expect(autoApprovableKinds().map(k => k.tag).toSorted()).toEqual([
      "confluence.addComment",
      "confluence.createContent",
      "confluence.editContent",
      "confluence.label",
      "confluence.restore",
      "confluence.setTitle",
      "confluence.uploadAttachment",
    ]);
  });
});

describe("revertStoredAction", () => {
  it("marks the action reverted on success", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const id = stage(store, { type: "setTitle", contentId: "123", title: "New", previousTitle: "Old" });
    await applyStoredAction(store, id);

    await revertStoredAction(store, id);

    expect(store.getAction(id)?.state).toBe("reverted");
  });

  it("leaves the record applied when an append cannot be reverted", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const id = stage(store, { type: "appendContent", contentId: "123", markdown: "x" }); // no previousMarkdown
    await applyStoredAction(store, id);

    const result = await revertStoredAction(store, id);

    expect(result).toMatchObject({ message: expect.any(String) });
    expect(store.getAction(id)?.state).toBe("applied");
  });
});
