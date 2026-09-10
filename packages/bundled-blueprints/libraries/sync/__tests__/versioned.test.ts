// @vitest-environment node
import { describe, expect, it } from "vitest";

import { applyVersioned, normalizeBaseVersion, operationStatus } from "../src/versioned.ts";

interface Block {
  id: string;
  html: string;
  version: number;
}

const blocks = (...entries: Array<[id: string, html: string, version?: number]>): Block[] =>
  entries.map(([id, html, version]) => ({ id, html, version: version ?? 1 }));

describe("applyVersioned", () => {
  it("accepts an edit based on the current version and bumps the item", () => {
    const outcome = applyVersioned(blocks(["a", "<p>one</p>", 3], ["b", "<p>two</p>"]), {
      upserts: [{ id: "a", html: "<p>one!</p>", baseVersion: 3 }],
    });
    expect(outcome.accepted).toEqual([{ id: "a", html: "<p>one!</p>", version: 4 }]);
    expect(outcome.items.get("a")).toEqual({ id: "a", html: "<p>one!</p>", version: 4 });
    expect(outcome.items.get("b")).toEqual({ id: "b", html: "<p>two</p>", version: 1 });
    expect(outcome).toMatchObject({ deletedIds: [], conflicts: [], changed: true, status: "applied" });
  });

  it("rejects a stale edit with the authoritative item and leaves the items untouched", () => {
    const current = blocks(["a", "<p>server</p>", 4]);
    const outcome = applyVersioned(current, { upserts: [{ id: "a", html: "<p>mine</p>", baseVersion: 3 }] });
    expect(outcome.conflicts).toEqual([{ id: "a", reason: "stale", current: current[0] }]);
    expect(outcome.items.get("a")).toBe(current[0]);
    expect(outcome).toMatchObject({ accepted: [], changed: false, status: "conflict" });
  });

  it("creates a new item at version 1 and reports an edit of a missing one", () => {
    const outcome = applyVersioned(blocks(["a", "<p>a</p>"]), {
      upserts: [
        { id: "n", html: "<p>new</p>", baseVersion: 0 },
        { id: "gone", html: "<p>draft</p>", baseVersion: 2 },
      ],
    });
    expect(outcome.accepted).toEqual([{ id: "n", html: "<p>new</p>", version: 1 }]);
    expect(outcome.conflicts).toEqual([{ id: "gone", reason: "missing" }]);
    expect(Array.from(outcome.items.keys())).toEqual(["a", "n"]);
    expect(outcome.status).toBe("conflict");
  });

  it("treats identical content as no change, and lets the gadget judge nested content", () => {
    const same = applyVersioned(blocks(["a", "<p>a</p>", 2]), { upserts: [{ id: "a", html: "<p>a</p>", baseVersion: 2 }] });
    expect(same).toMatchObject({ accepted: [], conflicts: [], changed: false, status: "unchanged" });
    expect(same.items.get("a")?.version).toBe(2);

    type Cell = { id: string; fmt: { b?: boolean } | null; version: number };
    const cells: Cell[] = [{ id: "A1", fmt: { b: true }, version: 1 }];
    const byDefault = applyVersioned(cells, { upserts: [{ id: "A1", fmt: { b: true }, baseVersion: 1 }] });
    expect(byDefault.changed).toBe(true);
    const judged = applyVersioned(cells, { upserts: [{ id: "A1", fmt: { b: true }, baseVersion: 1 }] }, {
      isUnchanged: (current, incoming) => JSON.stringify(current.fmt) === JSON.stringify(incoming.fmt),
    });
    expect(judged.changed).toBe(false);
  });

  it("version-checks deletions and ignores deleting what is already gone", () => {
    const current = blocks(["a", "<p>a</p>", 2], ["b", "<p>b</p>", 1]);
    const outcome = applyVersioned(current, {
      deletes: [
        { id: "a", baseVersion: 1 },
        { id: "b", baseVersion: 1 },
        { id: "zz", baseVersion: 0 },
      ],
    });
    expect(outcome.deletedIds).toEqual(["b"]);
    expect(outcome.conflicts).toEqual([{ id: "a", reason: "stale", current: current[0] }]);
    expect(Array.from(outcome.items.keys())).toEqual(["a"]);
    expect(outcome.status).toBe("conflict");
  });

  it("applies a batch in order, so a deletion sees the upsert before it", () => {
    const outcome = applyVersioned(blocks(["a", "<p>a</p>", 1]), {
      upserts: [{ id: "a", html: "<p>a2</p>", baseVersion: 1 }],
      deletes: [{ id: "a", baseVersion: 1 }],
    });
    expect(outcome.accepted).toHaveLength(1);
    expect(outcome.deletedIds).toEqual([]);
    expect(outcome.conflicts[0]).toMatchObject({ id: "a", reason: "stale", current: { version: 2 } });
  });

  it("does not modify the items it was given", () => {
    const current = blocks(["a", "<p>a</p>"]);
    const map = new Map(current.map((block) => [block.id, block]));
    applyVersioned(map.values(), { upserts: [{ id: "a", html: "<p>b</p>", baseVersion: 1 }], deletes: [] });
    expect(current[0]).toEqual({ id: "a", html: "<p>a</p>", version: 1 });
    expect(map.get("a")).toBe(current[0]);
  });
});

describe("operationStatus and normalizeBaseVersion", () => {
  it("ranks conflict over applied over unchanged", () => {
    expect(operationStatus(true, [{}])).toBe("conflict");
    expect(operationStatus(false, [{}])).toBe("conflict");
    expect(operationStatus(true, [])).toBe("applied");
    expect(operationStatus(false, [])).toBe("unchanged");
  });

  it("reads a base version as a non-negative integer", () => {
    expect(normalizeBaseVersion(3)).toBe(3);
    expect(normalizeBaseVersion("2")).toBe(2);
    expect(normalizeBaseVersion(2.9)).toBe(2);
    expect(normalizeBaseVersion(-1)).toBe(0);
    expect(normalizeBaseVersion(undefined)).toBe(0);
    expect(normalizeBaseVersion(Number.NaN)).toBe(0);
  });
});
