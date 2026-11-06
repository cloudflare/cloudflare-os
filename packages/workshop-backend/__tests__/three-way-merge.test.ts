import { describe, expect, it } from "vitest";
import { threeWayMerge } from "../src/three-way-merge";

describe("threeWayMerge", () => {
  const files = (entries: Record<string, string>) => new Map(Object.entries(entries));

  it("merges a large file both sides changed, conflicts and all", () => {
    // No size is refused here: whether the result fits is for storage to say when it is
    // committed. The conflict holds all three versions, about 600K characters.
    let lines = (word: string) => `${word.repeat(250)}\n`.repeat(200);
    let result = threeWayMerge(
        files({ "big.js": lines("base") }),
        files({ "big.js": lines("ours") }),
        files({ "big.js": lines("thrs") }));
    expect(result.conflictPaths).toEqual(["big.js"]);
    expect(result.files.get("big.js")!.length).toBeGreaterThan(3 * lines("base").length);
  });

  it("merges disjoint changes cleanly", () => {
    let result = threeWayMerge(
        files({ "a.js": "a\nb\nc\nd\ne\n", "same.js": "s\n" }),
        files({ "a.js": "A\nb\nc\nd\ne\n", "same.js": "s\n", "added.js": "new\n" }),
        files({ "a.js": "a\nb\nc\nd\nE\n", "same.js": "s\n" }));
    expect(result.conflictPaths).toEqual([]);
    expect(result.files).toEqual(files({
      "a.js": "A\nb\nc\nd\nE\n",  // line edits from both sides, merged by diff3
      "same.js": "s\n",
      "added.js": "new\n",
    }));
  });

  it("lets a lone side win, including deletions", () => {
    let result = threeWayMerge(
        files({ "mod.js": "old\n", "deleted-by-ours.js": "x\n", "deleted-by-theirs.js": "y\n" }),
        files({ "mod.js": "new\n", "deleted-by-theirs.js": "y\n" }),
        files({ "mod.js": "old\n", "deleted-by-ours.js": "x\n" }));
    expect(result.conflictPaths).toEqual([]);
    expect(result.files).toEqual(files({ "mod.js": "new\n" }));
  });

  it("treats identical changes on both sides as clean", () => {
    let result = threeWayMerge(
        files({ "a.js": "old\n" }),
        files({ "a.js": "new\n", "added.js": "same\n" }),
        files({ "a.js": "new\n", "added.js": "same\n" }));
    expect(result.conflictPaths).toEqual([]);
    expect(result.files).toEqual(files({ "a.js": "new\n", "added.js": "same\n" }));
  });

  it("marks overlapping edits with 3-way conflict markers", () => {
    let result = threeWayMerge(
        files({ "a.js": "line1\nline2\nline3\n" }),
        files({ "a.js": "line1\nOURS\nline3\n" }),
        files({ "a.js": "line1\nTHEIRS\nline3\n" }),
        { ours: "mainline", theirs: "chat", base: "merged" });
    expect(result.conflictPaths).toEqual(["a.js"]);
    expect(result.files.get("a.js")).toBe(
        "line1\n" +
        "<<<<<<< mainline\n" +
        "OURS\n" +
        "||||||| merged\n" +
        "line2\n" +
        "=======\n" +
        "THEIRS\n" +
        ">>>>>>> chat\n" +
        "line3\n");
  });

  it("marks both-sides-added files as conflicts", () => {
    // The case a conventional git merge stops at rather than marking.
    let result = threeWayMerge(
        files({}),
        files({ "new.js": "foo\n" }),
        files({ "new.js": "bar\n" }));
    expect(result.conflictPaths).toEqual(["new.js"]);
    expect(result.files.get("new.js")).toBe(
        "<<<<<<< ours\n" +
        "foo\n" +
        "||||||| base\n" +
        "=======\n" +
        "bar\n" +
        ">>>>>>> theirs\n");
  });

  it("keeps modified content on delete-vs-modify conflicts", () => {
    let result = threeWayMerge(
        files({ "a.js": "x\n", "b.js": "x\n" }),
        files({ "b.js": "ours\n" }),                    // ours deleted a.js, modified b.js
        files({ "a.js": "theirs\n" }));                 // theirs modified a.js, deleted b.js
    expect(result.conflictPaths).toEqual(["a.js", "b.js"]);
    expect(result.files).toEqual(files({ "a.js": "theirs\n", "b.js": "ours\n" }));
  });

  it("preserves bare \\r and U+2028/U+2029, which are not line boundaries here", () => {
    // A lossy line split (one that treats these as boundaries but drops them) would corrupt
    // merged content; splitLines keeps them inside their line instead, merely coarsening the
    // merge granularity for such files.
    let result = threeWayMerge(
        files({ "a.js": "one\rtwo\u2028three\nmid\nend\n" }),
        files({ "a.js": "one\rtwo\u2028three\nmid\nEND\n" }),
        files({ "a.js": "ONE\rtwo\u2028three\nmid\nend\n" }));
    expect(result.conflictPaths).toEqual([]);
    expect(result.files.get("a.js")).toBe("ONE\rtwo\u2028three\nmid\nEND\n");
  });

  it("terminates unterminated conflict hunks with a newline", () => {
    let result = threeWayMerge(
        files({ "a.js": "x" }), files({ "a.js": "y" }), files({ "a.js": "z" }));
    expect(result.conflictPaths).toEqual(["a.js"]);
    expect(result.files.get("a.js")).toBe(
        "<<<<<<< ours\ny\n||||||| base\nx\n=======\nz\n>>>>>>> theirs\n");
  });
});
