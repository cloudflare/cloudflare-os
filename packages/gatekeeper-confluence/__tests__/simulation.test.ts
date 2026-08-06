import { describe, expect, it } from "vite-plus/test";
import {
  simulateBody,
  simulateTitle,
  simulateLabels,
  simulateComments,
  simulateTrashed,
  type ConfluenceAction,
  type StoredActionRecord,
} from "../src/confluence-actions";

let nextId = 1;
function rec(action: ConfluenceAction): StoredActionRecord {
  const id = nextId++;
  return { id, action, state: "pending", submittedAt: id * 1000 };
}

describe("simulateTitle", () => {
  it("returns the base title when no actions touch it", () => {
    expect(simulateTitle([], "Original")).toBe("Original");
  });

  it("applies the latest setTitle", () => {
    const records = [
      rec({ type: "setTitle", contentId: "1", title: "First", previousTitle: "Original" }),
      rec({ type: "setTitle", contentId: "1", title: "Second", previousTitle: "First" }),
    ];
    expect(simulateTitle(records, "Original")).toBe("Second");
  });

  it("uses a provisional content's create title", () => {
    const records = [
      rec({ type: "createContent", provisionalId: "~1", kind: "page", parent: { type: "space", spaceKey: "ENG" }, title: "New Page", status: "current" }),
    ];
    expect(simulateTitle(records, "")).toBe("New Page");
  });
});

describe("simulateBody", () => {
  it("returns the base body when no actions touch it", () => {
    expect(simulateBody("hello", [])).toBe("hello");
  });

  it("replaces the body on setContent", () => {
    const records = [rec({ type: "setContent", contentId: "1", markdown: "replaced", previousMarkdown: "hello" })];
    expect(simulateBody("hello", records)).toBe("replaced");
  });

  it("appends to the body on appendContent", () => {
    const records = [rec({ type: "appendContent", contentId: "1", markdown: "more" })];
    expect(simulateBody("hello", records)).toBe("hello\n\nmore");
  });

  it("applies setContent then appendContent in order", () => {
    const records = [
      rec({ type: "setContent", contentId: "1", markdown: "base", previousMarkdown: "hello" }),
      rec({ type: "appendContent", contentId: "1", markdown: "tail" }),
    ];
    expect(simulateBody("hello", records)).toBe("base\n\ntail");
  });

  it("seeds the body from a provisional create", () => {
    const records = [
      rec({ type: "createContent", provisionalId: "~1", kind: "page", parent: { type: "space", spaceKey: "ENG" }, title: "T", content: "seed", status: "current" }),
    ];
    expect(simulateBody(null, records)).toBe("seed");
  });
});

describe("simulateLabels", () => {
  it("adds and removes labels, ignoring duplicates", () => {
    const records = [
      rec({ type: "addLabel", contentId: "1", name: "urgent" }),
      rec({ type: "addLabel", contentId: "1", name: "urgent" }),
      rec({ type: "addLabel", contentId: "1", name: "draft" }),
      rec({ type: "removeLabel", contentId: "1", name: "old" }),
    ];
    expect(simulateLabels(["old", "keep"], records)).toEqual(["keep", "urgent", "draft"]);
  });
});

describe("simulateComments", () => {
  it("appends pending comments after base comments", () => {
    const base = [{ id: "c1", text: "existing", author: null, createdAt: new Date(0) }];
    const records = [rec({ type: "addComment", contentId: "1", text: "new comment" })];
    const result = simulateComments(base, records);
    expect(result).toHaveLength(2);
    expect(result[1].text).toBe("new comment");
  });
});

describe("simulateTrashed", () => {
  it("returns undefined when nothing touches trashed state", () => {
    expect(simulateTrashed([])).toBeUndefined();
  });

  it("reflects the latest trash/restore", () => {
    expect(simulateTrashed([rec({ type: "trash", contentId: "1" })])).toBe(true);
    expect(simulateTrashed([
      rec({ type: "trash", contentId: "1" }),
      rec({ type: "restore", contentId: "1" }),
    ])).toBe(false);
  });
});
