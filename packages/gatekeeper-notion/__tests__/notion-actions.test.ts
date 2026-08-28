import { describe, expect, it } from "vitest";
import {
  NotionStore,
  applyStoredActionsThrough,
  type NotionAction,
} from "../src/notion-actions";
import type { NotionApi } from "../src/notion-api";

type Kv = ConstructorParameters<typeof NotionStore>[0];

function makeKv(): Kv {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key: string, value: unknown) => void map.set(key, value),
    delete: (key: string) => void map.delete(key),
    list: <T>({ prefix }: { prefix: string }) =>
      [...map.entries()].filter(([key]) => key.startsWith(prefix)) as [string, T][],
  } as unknown as Kv;
}

function makeStore() {
  const comments: string[] = [];
  const api = {
    createComment: async ({ parent }: { parent: { page_id: string } }) => {
      comments.push(parent.page_id);
      if (parent.page_id === "failed") throw new Error("safe failure");
      return {};
    },
  } as unknown as NotionApi;
  return { store: new NotionStore(makeKv(), api), comments };
}

function stage(store: NotionStore, action: NotionAction): number {
  const id = store.nextActionId();
  store.putAction({ id, action, state: "pending", submittedAt: id });
  return id;
}

describe("applyStoredActionsThrough", () => {
  it("skips sparse IDs and stops at the first failed action", async () => {
    const { store, comments } = makeStore();
    const first = stage(store, { type: "addComment", pageId: "first", text: "one" });
    const hole = stage(store, { type: "addComment", pageId: "hole", text: "two" });
    const failed = stage(store, { type: "addComment", pageId: "failed", text: "three" });
    const later = stage(store, { type: "addComment", pageId: "later", text: "four" });
    store.deleteAction(hole);

    const result = await applyStoredActionsThrough(store, later, []);

    expect(comments).toEqual(["first", "failed"]);
    expect(store.getAction(first)?.state).toBe("applied");
    expect(store.getAction(failed)?.state).toBe("pending");
    expect(store.getAction(later)?.state).toBe("pending");
    expect(result.stopped).toMatchObject({ at: failed, reason: expect.any(Error) });
  });

  it("stops at a staged action whose submission has not completed", async () => {
    const { store, comments } = makeStore();
    const staged = store.nextActionId();
    store.putAction({
      id: staged, action: { type: "addComment", pageId: "staged", text: "early" },
      state: "staged", submittedAt: staged,
    });
    const pending = stage(store, { type: "addComment", pageId: "later", text: "late" });

    const result = await applyStoredActionsThrough(store, pending, []);

    // The staged action can't be applied but must not be silently skipped either (the caller
    // would infer everything through `pending` was applied), so the pass stops at it.
    expect(result.stopped).toMatchObject({ at: staged, reason: expect.any(Error) });
    expect(comments).toHaveLength(0);
    expect(store.getAction(staged)?.state).toBe("staged");
    expect(store.getAction(pending)?.state).toBe("pending");
  });

  it("persists transitive invalidations and reports them again on retry", async () => {
    const { store, comments } = makeStore();
    const root = stage(store, {
      type: "createPage", provisionalId: "~root", parent: { kind: "workspace" }, title: "Root",
    });
    const child = stage(store, {
      type: "createPage", provisionalId: "~child", parent: { kind: "page", pageId: "~root" },
      title: "Child",
    });
    const edit = stage(store, { type: "addComment", pageId: "~child", text: "Comment" });

    const first = await applyStoredActionsThrough(store, root, [root]);
    const retry = await applyStoredActionsThrough(store, root, [root]);

    expect(first.invalidatedByVeto).toEqual([
      { action: child, invalidatedBy: root },
      { action: edit, invalidatedBy: root },
    ]);
    expect(retry.invalidatedByVeto).toEqual(first.invalidatedByVeto);
    // Vetoed and invalidated records are deleted so read overlays recompute without them.
    expect(store.getAction(root)).toBeUndefined();
    expect(store.getAction(edit)).toBeUndefined();
    expect(store.knowsProvisional("~root")).toBe(false);
    expect(comments).toHaveLength(0);
  });

  it("ignores a veto of an already-applied action", async () => {
    const { store, comments } = makeStore();
    const id = stage(store, { type: "addComment", pageId: "page", text: "Comment" });
    await applyStoredActionsThrough(store, id, []);

    const result = await applyStoredActionsThrough(store, id, [id]);

    expect(result).toEqual({});
    expect(store.getAction(id)?.state).toBe("applied");
    expect(comments).toEqual(["page"]);
  });

  it("rejects an out-of-range veto before changing state", async () => {
    const { store, comments } = makeStore();
    const id = stage(store, { type: "addComment", pageId: "page", text: "Comment" });

    await expect(applyStoredActionsThrough(store, id, [id + 1]))
      .rejects.toThrow("Invalid veto action ID");

    expect(store.getAction(id)?.state).toBe("pending");
    expect(comments).toHaveLength(0);
  });
});
