import { describe, expect, it } from "vitest";
import { contextPath, parseContextPath } from "./navigation";

describe("Context app paths", () => {
  it.each([
    ["/", { kind: "library" }],
    ["/collections/c1", { kind: "collection", collectionId: "c1", documentPath: null }],
    [
      "/collections/c1/files/guides/a b#?%.md",
      { kind: "collection", collectionId: "c1", documentPath: "guides/a b#?%.md" },
    ],
    // Git-mirrored files may exceed the 1,024-character limit on web edits and must still open.
    [
      `/collections/c1/files/${"x".repeat(1_025)}.md`,
      { kind: "collection", collectionId: "c1", documentPath: `${"x".repeat(1_025)}.md` },
    ],
  ])("round-trips %s", (path, view) => {
    expect(parseContextPath(path)).toEqual(view);
    const collectionId = "collectionId" in view ? view.collectionId : null;
    const documentPath = "documentPath" in view ? view.documentPath : null;
    expect(contextPath(collectionId, documentPath)).toBe(path);
  });

  it.each([
    "",
    "collections/c1",
    "/collections",
    "/collections/",
    "/c1",
    "/collections/c1/",
    "/collections/c1/docs/a.md",
    "/collections/c1/files",
    "/collections/c1/files/",
  ])("treats %j as invalid", (path) => {
    expect(parseContextPath(path)).toEqual({ kind: "invalid" });
  });
});
