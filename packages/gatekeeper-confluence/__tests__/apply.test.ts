import { describe, expect, it } from "vitest";
import {
  ConfluenceStore,
  applyStoredActionsThrough,
  applyStoredAction,
  revertStoredAction,
  stageAction,
  type ConfluenceAction,
} from "../src/confluence-actions";
import type { ConfluenceApi } from "../src/confluence-api";

type Kv = ConstructorParameters<typeof ConfluenceStore>[0];

// Minimal in-memory KV matching the slice of the DO storage API the store uses.
function makeKv(): Kv {
  const map = new Map<string, unknown>();
  return {
    get: <T>(k: string) => map.get(k) as T | undefined,
    put: (k: string, v: unknown) => void map.set(k, v),
    delete: (k: string) => void map.delete(k),
    list: <T>({ prefix }: { prefix: string }) =>
      [...map.entries()].filter(([k]) => k.startsWith(prefix)) as [string, T][],
  } as unknown as Kv;
}

type Recorded = {
  addComment: { id: string; type: string }[];
  updateContent: { title: string; status?: string }[];
};

// Fake API recording the calls apply/revert make. `contentType` controls what getContentById reports;
// `status` controls whether the target page reads back as a draft or a published ("current") page.
function makeApi(contentType: "page" | "blogpost" = "page", status: string = "current") {
  const calls: Recorded = { addComment: [], updateContent: [] };
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
  } as unknown as ConfluenceApi;
  return { api, calls };
}

function storeWith(api: ConfluenceApi) {
  return new ConfluenceStore(makeKv(), api);
}

function stage(store: ConfluenceStore, action: ConfluenceAction): number {
  const id = store.nextActionId();
  store.putAction({ id, action, state: "pending", submittedAt: id });
  return id;
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
});

describe("applyStoredActionsThrough", () => {
  it("skips sparse IDs and stops at the first failed action", async () => {
    const { api, calls } = makeApi();
    const store = storeWith(api);
    const first = stage(store, { type: "addComment", contentId: "first", text: "one" });
    const hole = stage(store, { type: "addComment", contentId: "hole", text: "two" });
    const failed = stage(store, { type: "addComment", contentId: "failed", text: "three" });
    const later = stage(store, { type: "addComment", contentId: "later", text: "four" });
    store.deleteAction(hole);
    api.addComment = async (id: string, _storage: string, type: string) => {
      calls.addComment.push({ id, type });
      if (id === "failed") throw new Error("safe failure");
      return { id: `comment-${id}` };
    };

    const result = await applyStoredActionsThrough(store, later, []);

    expect(calls.addComment.map(call => call.id)).toEqual(["first", "failed"]);
    expect(store.getAction(first)?.state).toBe("applied");
    expect(store.getAction(failed)?.state).toBe("pending");
    expect(store.getAction(later)?.state).toBe("pending");
    // The specific apply error is passed through so the user can resolve the problem.
    expect(result.stopped).toMatchObject({ at: failed, reason: expect.any(Error) });
    expect(result.stopped?.reason.message).toBe("safe failure");
  });

  it("does not re-apply earlier actions when retried after a stop", async () => {
    const { api, calls } = makeApi();
    const store = storeWith(api);
    const first = stage(store, { type: "addComment", contentId: "first", text: "one" });
    const flaky = stage(store, { type: "addComment", contentId: "flaky", text: "two" });
    let failOnce = true;
    api.addComment = async (id: string, _storage: string, type: string) => {
      calls.addComment.push({ id, type });
      if (id === "flaky" && failOnce) {
        failOnce = false;
        throw new Error("temporarily unavailable");
      }
      return { id: `comment-${id}` };
    };

    const stopped = await applyStoredActionsThrough(store, flaky, []);
    const retry = await applyStoredActionsThrough(store, flaky, []);

    expect(stopped.stopped).toMatchObject({ at: flaky });
    expect(retry).toEqual({});
    expect(calls.addComment.map(call => call.id)).toEqual(["first", "flaky", "flaky"]);
    expect(store.getAction(first)?.state).toBe("applied");
    expect(store.getAction(flaky)?.state).toBe("applied");
  });

  it("never applies a staged action whose submission has not completed", async () => {
    const { api, calls } = makeApi();
    const store = storeWith(api);
    const staged = store.nextActionId();
    store.putAction({
      id: staged, action: { type: "addComment", contentId: "staged", text: "early" },
      state: "staged", submittedAt: staged,
    });
    const pending = stage(store, { type: "addComment", contentId: "later", text: "late" });

    const result = await applyStoredActionsThrough(store, pending, []);

    // The staged action can't be applied but must not be silently skipped either (the caller
    // would infer everything through `pending` was applied), so the pass stops at it.
    expect(result.stopped).toMatchObject({ at: staged, reason: expect.any(Error) });
    expect(calls.addComment).toHaveLength(0);
    expect(store.getAction(staged)?.state).toBe("staged");
    expect(store.getAction(pending)?.state).toBe("pending");
  });

  it("persists transitive invalidations and reports them again on retry", async () => {
    const { api, calls } = makeApi();
    const store = storeWith(api);
    const root = stage(store, {
      type: "createContent", provisionalId: "~root", kind: "page",
      parent: { type: "space", spaceKey: "ENG" }, title: "Root", status: "current",
    });
    const edit = stage(store, {
      type: "setTitle", contentId: "~root", title: "Edited", previousTitle: "Root",
    });
    const child = stage(store, {
      type: "createContent", provisionalId: "~child", kind: "page",
      parent: { type: "page", parentId: "~root", spaceKey: "ENG" }, title: "Child", status: "current",
    });
    const childEdit = stage(store, {
      type: "addComment", contentId: "~child", text: "Comment",
    });

    const first = await applyStoredActionsThrough(store, root, [root]);
    const retry = await applyStoredActionsThrough(store, root, [root]);

    expect(first.invalidatedByVeto).toEqual([
      { action: edit, invalidatedBy: root },
      { action: child, invalidatedBy: root },
      { action: childEdit, invalidatedBy: root },
    ]);
    expect(retry.invalidatedByVeto).toEqual(first.invalidatedByVeto);
    // Vetoed and invalidated records are deleted so read overlays recompute without them.
    expect(store.getAction(root)).toBeUndefined();
    expect(store.getAction(childEdit)).toBeUndefined();
    expect(store.knowsProvisional("~root")).toBe(false);
    expect(calls.addComment).toHaveLength(0);
  });

  it("makes the legacy single-action path throw for a cascade-invalidated action", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const root = stage(store, {
      type: "createContent", provisionalId: "~root", kind: "page",
      parent: { type: "space", spaceKey: "ENG" }, title: "Root", status: "current",
    });
    const edit = stage(store, {
      type: "setTitle", contentId: "~root", title: "Edited", previousTitle: "Root",
    });

    await applyStoredActionsThrough(store, root, [root]);

    // An un-migrated overseer applying the orphan must see a failure, not a silent success.
    await expect(applyStoredAction(store, edit)).rejects.toThrow(`Unknown action: ${edit}`);
  });

  it("ignores a veto of an already-applied action", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const id = stage(store, { type: "addComment", contentId: "page", text: "Comment" });
    await applyStoredActionsThrough(store, id, []);

    const result = await applyStoredActionsThrough(store, id, [id]);

    expect(result).toEqual({});
    expect(store.getAction(id)?.state).toBe("applied");
  });

  it("rejects an out-of-range veto before changing state", async () => {
    const { api, calls } = makeApi();
    const store = storeWith(api);
    const id = stage(store, { type: "addComment", contentId: "page", text: "Comment" });

    await expect(applyStoredActionsThrough(store, id, [id + 1]))
      .rejects.toThrow("Invalid veto action ID");

    expect(store.getAction(id)?.state).toBe("pending");
    expect(calls.addComment).toHaveLength(0);
  });

  it("persists later vetoes before an earlier action fails", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const failed = stage(store, { type: "addComment", contentId: "failed", text: "Comment" });
    const vetoed = stage(store, {
      type: "createContent", provisionalId: "~root", kind: "page",
      parent: { type: "space", spaceKey: "ENG" }, title: "Root", status: "current",
    });
    const invalidated = stage(store, {
      type: "setTitle", contentId: "~root", title: "Edited", previousTitle: "Root",
    });
    api.addComment = async () => { throw new Error("safe failure"); };

    const result = await applyStoredActionsThrough(store, invalidated, [vetoed]);

    expect(result.stopped?.at).toBe(failed);
    expect(result.invalidatedByVeto).toEqual([{ action: invalidated, invalidatedBy: vetoed }]);
    expect(store.getAction(vetoed)).toBeUndefined();
    expect(store.getAction(invalidated)).toBeUndefined();
  });
});

describe("stageAction", () => {
  it("keeps the record staged until submitAction completes", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    let stateDuringSubmit: string | undefined;
    const approvalQueue = {
      submitAction: async (id: number) => {
        stateDuringSubmit = store.getAction(id)?.state;
      },
    } as unknown as Parameters<typeof stageAction>[1];

    const id = await stageAction(store, approvalQueue, {
      type: "addComment", contentId: "page", text: "Comment",
    });

    expect(stateDuringSubmit).toBe("staged");
    expect(store.getAction(id)?.state).toBe("pending");
  });

  it("rolls the record back when submitAction fails", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const approvalQueue = {
      submitAction: async () => { throw new Error("submit failed"); },
    } as unknown as Parameters<typeof stageAction>[1];

    await expect(stageAction(store, approvalQueue, {
      type: "addComment", contentId: "page", text: "Comment",
    })).rejects.toThrow("submit failed");

    expect(store.allActions()).toHaveLength(0);
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
