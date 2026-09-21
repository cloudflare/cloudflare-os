// Pure-logic coverage for git-diff.ts: tree-object parsing, the pruning tree-to-tree walk, and
// the line-level unified diff whose hunks must match the shape parsePatch produces from GitHub's
// own patches.

import { describe, expect, it } from "vitest";
import {
  MAX_DIFF_BLOB_BYTES,
  TreeUnavailableError,
  changedPathsBetweenTrees,
  diffGitTrees,
  diffTextLines,
  parseGitTreePayload,
  treeEntryKind,
  type GitTreeEntry,
  type TreeDiffSource,
} from "../src/git-diff";

/** Deterministic fake full oid. */
function oid(n: number): string {
  return n.toString(16).padStart(40, "0");
}

function treePayload(entries: { mode: string; name: string; oid: string }[]): Uint8Array {
  const encoder = new TextEncoder();
  const pieces = entries.flatMap(entry => {
    const oidBytes = new Uint8Array(20);
    for (let i = 0; i < 20; i++) {
      oidBytes[i] = parseInt(entry.oid.slice(i * 2, i * 2 + 2), 16);
    }
    return [encoder.encode(`${entry.mode} ${entry.name}\0`), oidBytes];
  });
  const out = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.byteLength;
  }
  return out;
}

/** An in-memory TreeDiffSource that records which objects were fetched. */
function fakeSource(
  trees: Record<string, GitTreeEntry[]>,
  blobs: Record<string, Uint8Array | "unavailable">,
) {
  const treeReads: string[] = [];
  const blobReads: string[] = [];
  const source: TreeDiffSource = {
    getTree: async id => {
      treeReads.push(id);
      return trees[id] ?? null;
    },
    getBlob: async id => {
      blobReads.push(id);
      return blobs[id] ?? "unavailable";
    },
  };
  return { source, treeReads, blobReads };
}

const text = (value: string) => new TextEncoder().encode(value);

describe("parseGitTreePayload", () => {
  it("round-trips modes, names, and oids", () => {
    const entries = [
      { mode: "100644", name: "a.txt", oid: oid(1) },
      { mode: "40000", name: "sub", oid: oid(2) },
      { mode: "100755", name: "run.sh", oid: oid(3) },
      { mode: "120000", name: "link", oid: oid(4) },
      { mode: "160000", name: "vendored", oid: oid(5) },
    ];
    expect(parseGitTreePayload(treePayload(entries), oid(9))).toEqual(entries);
    expect(entries.map(entry => treeEntryKind(entry.mode)))
      .toEqual(["file", "dir", "file", "symlink", "gitlink"]);
  });

  it("rejects truncated payloads and non-UTF-8 names", () => {
    const good = treePayload([{ mode: "100644", name: "a", oid: oid(1) }]);
    expect(() => parseGitTreePayload(good.subarray(0, good.length - 1), oid(9)))
      .toThrow(/not a well-formed tree/);

    const badName = new Uint8Array([...text("100644 "), 0xff, 0, ...new Uint8Array(20)]);
    expect(() => parseGitTreePayload(badName, oid(9))).toThrow(/non-UTF-8 entry name/);
  });

  it("keeps a leading BOM in an entry name, so it cannot alias the BOM-less name", () => {
    const entries = [
      { mode: "100644", name: "a.txt", oid: oid(1) },
      { mode: "100644", name: "\uFEFFa.txt", oid: oid(2) },
    ];
    expect(parseGitTreePayload(treePayload(entries), oid(9))).toEqual(entries);
  });
});

describe("diffTextLines", () => {
  it("produces a single hunk with three lines of context around one change", () => {
    const oldText = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
    const newText = oldText.replace("line5", "changed5");

    const { hunks, additions, deletions } = diffTextLines(oldText, newText);
    expect(additions).toBe(1);
    expect(deletions).toBe(1);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].header).toBe("@@ -2,7 +2,7 @@");
    expect(hunks[0].lines).toEqual([
      { kind: "context", text: "line2", oldLineNumber: 2, newLineNumber: 2 },
      { kind: "context", text: "line3", oldLineNumber: 3, newLineNumber: 3 },
      { kind: "context", text: "line4", oldLineNumber: 4, newLineNumber: 4 },
      { kind: "removed", text: "line5", oldLineNumber: 5 },
      { kind: "added", text: "changed5", newLineNumber: 5 },
      { kind: "context", text: "line6", oldLineNumber: 6, newLineNumber: 6 },
      { kind: "context", text: "line7", oldLineNumber: 7, newLineNumber: 7 },
      { kind: "context", text: "line8", oldLineNumber: 8, newLineNumber: 8 },
    ]);
  });

  it("uses git's -0,0 convention for a new file", () => {
    const { hunks, additions, deletions } = diffTextLines("", "a\nb\n");
    expect(additions).toBe(2);
    expect(deletions).toBe(0);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].header).toBe("@@ -0,0 +1,2 @@");
    expect(hunks[0].lines).toEqual([
      { kind: "added", text: "a", newLineNumber: 1 },
      { kind: "added", text: "b", newLineNumber: 2 },
    ]);
  });

  it("splits distant changes into separate hunks and merges nearby ones", () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line${i + 1}`);
    const changedFar = [...lines];
    changedFar[1] = "x2";
    changedFar[19] = "x20";
    const far = diffTextLines(lines.join("\n"), changedFar.join("\n"));
    expect(far.hunks.map(hunk => hunk.header)).toEqual(["@@ -1,5 +1,5 @@", "@@ -17,7 +17,7 @@"]);

    const changedNear = [...lines];
    changedNear[1] = "x2";
    changedNear[6] = "x7";
    const near = diffTextLines(lines.join("\n"), changedNear.join("\n"));
    expect(near.hunks).toHaveLength(1);
  });

  it("returns no hunks for identical content", () => {
    expect(diffTextLines("", "").hunks).toEqual([]);
    expect(diffTextLines("a\nb\n", "a\nb\n").hunks).toEqual([]);
    expect(diffTextLines("a\nb", "a\nb").hunks).toEqual([]);
  });

  // The EOF-newline cases below assert byte-for-byte what `git diff` emits for the same inputs.
  it("treats adding a trailing newline as a real change, like git", () => {
    const { hunks, additions, deletions } = diffTextLines("a\nb", "a\nb\n");
    expect(additions).toBe(1);
    expect(deletions).toBe(1);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].header).toBe("@@ -1,2 +1,2 @@");
    expect(hunks[0].lines).toEqual([
      { kind: "context", text: "a", oldLineNumber: 1, newLineNumber: 1 },
      { kind: "removed", text: "b", oldLineNumber: 2 },
      { kind: "context", text: "\\ No newline at end of file" },
      { kind: "added", text: "b", newLineNumber: 2 },
    ]);
  });

  it("marks both sides when a changed final line still lacks its newline", () => {
    const { hunks } = diffTextLines("a", "b");
    expect(hunks).toHaveLength(1);
    expect(hunks[0].header).toBe("@@ -1 +1 @@");
    expect(hunks[0].lines).toEqual([
      { kind: "removed", text: "a", oldLineNumber: 1 },
      { kind: "context", text: "\\ No newline at end of file" },
      { kind: "added", text: "b", newLineNumber: 1 },
      { kind: "context", text: "\\ No newline at end of file" },
    ]);
  });

  it("marks a no-eol context line at EOF once, and only when it lands in a hunk", () => {
    // A change near the unterminated last line pulls it in as context: one marker, both sides.
    const near = diffTextLines("line1\nline2\nend", "line1\nCHANGED\nend");
    expect(near.hunks).toHaveLength(1);
    expect(near.hunks[0].header).toBe("@@ -1,3 +1,3 @@");
    expect(near.hunks[0].lines).toEqual([
      { kind: "context", text: "line1", oldLineNumber: 1, newLineNumber: 1 },
      { kind: "removed", text: "line2", oldLineNumber: 2 },
      { kind: "added", text: "CHANGED", newLineNumber: 2 },
      { kind: "context", text: "end", oldLineNumber: 3, newLineNumber: 3 },
      { kind: "context", text: "\\ No newline at end of file" },
    ]);

    // A change far from it leaves the last line outside the hunk: no marker anywhere.
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    const changed = [...lines];
    changed[0] = "x1";
    const far = diffTextLines(lines.join("\n"), changed.join("\n"));
    expect(far.hunks).toHaveLength(1);
    expect(far.hunks[0].lines.every(line => line.text !== "\\ No newline at end of file"))
      .toBe(true);
  });

  it("marks an added or removed file that never had a final newline", () => {
    const added = diffTextLines("", "a");
    expect(added.hunks[0].lines).toEqual([
      { kind: "added", text: "a", newLineNumber: 1 },
      { kind: "context", text: "\\ No newline at end of file" },
    ]);
    const removed = diffTextLines("a", "");
    expect(removed.hunks[0].lines).toEqual([
      { kind: "removed", text: "a", oldLineNumber: 1 },
      { kind: "context", text: "\\ No newline at end of file" },
    ]);
  });

  it("finds a minimal script for interleaved edits", () => {
    const { hunks, additions, deletions } = diffTextLines("a\nb\nc\nd\n", "a\nx\nc\ny\nd\n");
    expect(deletions).toBe(1); // only "b" is removed
    expect(additions).toBe(2); // "x" and "y" are added
    expect(hunks).toHaveLength(1);
  });

  it("falls back to a whole remove-then-add block when the edit distance cap is exceeded", () => {
    const oldText = Array.from({ length: 700 }, (_, i) => `old${i}`).join("\n") + "\n";
    const newText = Array.from({ length: 700 }, (_, i) => `new${i}`).join("\n") + "\n";
    const { hunks, additions, deletions } = diffTextLines(oldText, newText);
    expect(deletions).toBe(700);
    expect(additions).toBe(700);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].header).toBe("@@ -1,700 +1,700 @@");
    // Correct, if not minimal: all removals then all additions.
    expect(hunks[0].lines[0]).toEqual({ kind: "removed", text: "old0", oldLineNumber: 1 });
    expect(hunks[0].lines[700]).toEqual({ kind: "added", text: "new0", newLineNumber: 1 });
  });

  it("scopes the fallback to the changed middle, keeping context from the common affixes", () => {
    // A capped change buried in a shared file: the fallback must not re-emit the common prefix
    // and suffix wholesale -- only the middle, padded with git's 3 context lines each side.
    const prefix = Array.from({ length: 10 }, (_, i) => `keep${i + 1}`);
    const suffix = Array.from({ length: 10 }, (_, i) => `tail${i + 1}`);
    const oldMid = Array.from({ length: 700 }, (_, i) => `old${i}`);
    const newMid = Array.from({ length: 700 }, (_, i) => `new${i}`);
    const { hunks, additions, deletions } = diffTextLines(
      [...prefix, ...oldMid, ...suffix].join("\n") + "\n",
      [...prefix, ...newMid, ...suffix].join("\n") + "\n");
    expect(deletions).toBe(700);
    expect(additions).toBe(700);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].header).toBe("@@ -8,706 +8,706 @@");
    expect(hunks[0].lines).toHaveLength(3 + 700 + 700 + 3);
    expect(hunks[0].lines[0]).toEqual(
      { kind: "context", text: "keep8", oldLineNumber: 8, newLineNumber: 8 });
    expect(hunks[0].lines.at(-1)).toEqual(
      { kind: "context", text: "tail3", oldLineNumber: 713, newLineNumber: 713 });
  });

  it("skips the Myers run entirely for an over-long changed middle", () => {
    // A pure insertion longer than MAX_DIFF_LINES_PER_FILE: too many lines to diff minimally,
    // even though its edit distance path would have been fine for jsdiff's memory.
    const inserted = Array.from({ length: 20001 }, (_, i) => `ins${i}`);
    const { hunks, additions, deletions } = diffTextLines(
      "a\nb\n", ["a", ...inserted, "b"].join("\n") + "\n");
    expect(deletions).toBe(0);
    expect(additions).toBe(20001);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].header).toBe("@@ -1,2 +1,20003 @@");
    expect(hunks[0].lines[0]).toEqual(
      { kind: "context", text: "a", oldLineNumber: 1, newLineNumber: 1 });
    expect(hunks[0].lines[1]).toEqual({ kind: "added", text: "ins0", newLineNumber: 2 });
    expect(hunks[0].lines.at(-1)).toEqual(
      { kind: "context", text: "b", oldLineNumber: 2, newLineNumber: 20003 });
  });

  it("keeps the EOF-newline markers in the fallback path", () => {
    const oldText = Array.from({ length: 700 }, (_, i) => `old${i}`).join("\n");
    const newText = Array.from({ length: 700 }, (_, i) => `new${i}`).join("\n");
    const { hunks } = diffTextLines(oldText, newText);  // both sides unterminated
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines[700]).toEqual({ kind: "context", text: "\\ No newline at end of file" });
    expect(hunks[0].lines.at(-1)).toEqual(
      { kind: "context", text: "\\ No newline at end of file" });
  });
});

describe("diffGitTrees", () => {
  // Old tree: a.txt (edited), sub/x.txt (unchanged), big.bin (unchanged).
  // New tree adds sub/y.txt.
  const trees: Record<string, GitTreeEntry[]> = {
    [oid(10)]: [
      { mode: "100644", name: "a.txt", oid: oid(1) },
      { mode: "100644", name: "big.bin", oid: oid(5) },
      { mode: "40000", name: "sub", oid: oid(11) },
    ],
    [oid(20)]: [
      { mode: "100644", name: "a.txt", oid: oid(2) },
      { mode: "100644", name: "big.bin", oid: oid(5) },
      { mode: "40000", name: "sub", oid: oid(21) },
    ],
    [oid(11)]: [{ mode: "100644", name: "x.txt", oid: oid(3) }],
    [oid(21)]: [
      { mode: "100644", name: "x.txt", oid: oid(3) },
      { mode: "100644", name: "y.txt", oid: oid(4) },
    ],
  };
  const blobs: Record<string, Uint8Array | "unavailable"> = {
    [oid(1)]: text("hello\nworld\n"),
    [oid(2)]: text("hello\nthere\nworld\n"),
    [oid(4)]: text("new file\n"),
  };

  it("diffs changed files, prunes unchanged entries, and never loads untouched blobs", async () => {
    const { source, blobReads } = fakeSource(trees, blobs);
    const files = await diffGitTrees(source, oid(10), oid(20));

    expect(files.map(file => [file.path, file.status])).toEqual([
      ["a.txt", "modified"],
      ["sub/y.txt", "added"],
    ]);
    const [aTxt, yTxt] = files;
    expect(aTxt.additions).toBe(1);
    expect(aTxt.deletions).toBe(0);
    expect(aTxt.diffOmitted).toBe(false);
    expect(aTxt.hunks[0].lines).toContainEqual({ kind: "added", text: "there", newLineNumber: 2 });
    expect(yTxt.additions).toBe(1);
    expect(yTxt.hunks[0].header).toBe("@@ -0,0 +1 @@");
    // The unchanged big.bin (same oid both sides) and x.txt must never be fetched.
    expect(blobReads).not.toContain(oid(5));
    expect(blobReads).not.toContain(oid(3));
  });

  it("treats a null old tree as empty (the whole new tree is added)", async () => {
    const { source } = fakeSource(trees, blobs);
    const files = await diffGitTrees(source, null, oid(21));
    expect(files.map(file => [file.path, file.status])).toEqual([
      ["x.txt", "added"],
      ["y.txt", "added"],
    ]);
  });

  it("reports binary, oversized, and unavailable content as diffOmitted", async () => {
    const binary = new Uint8Array([1, 2, 0, 3]);
    const huge = new Uint8Array(MAX_DIFF_BLOB_BYTES + 1);
    huge.fill(0x61);
    const { source } = fakeSource(
      {
        [oid(30)]: [],
        [oid(31)]: [
          { mode: "100644", name: "bin.dat", oid: oid(6) },
          { mode: "100644", name: "huge.txt", oid: oid(7) },
          { mode: "100644", name: "gone.txt", oid: oid(8) },
        ],
      },
      { [oid(6)]: binary, [oid(7)]: huge, [oid(8)]: "unavailable" },
    );
    const files = await diffGitTrees(source, oid(30), oid(31));
    expect(files).toHaveLength(3);
    for (const file of files) {
      expect(file.status).toBe("added");
      expect(file.diffOmitted).toBe(true);
      expect(file.hunks).toEqual([]);
      expect(file.additions).toBe(0);
    }
  });

  it("reports submodule pointer and mode-only changes without a patch", async () => {
    const { source, blobReads } = fakeSource(
      {
        [oid(30)]: [
          { mode: "160000", name: "vendored", oid: oid(6) },
          { mode: "100644", name: "run.sh", oid: oid(7) },
        ],
        [oid(31)]: [
          { mode: "160000", name: "vendored", oid: oid(9) },
          { mode: "100755", name: "run.sh", oid: oid(7) },
        ],
      },
      {},
    );
    const files = await diffGitTrees(source, oid(30), oid(31));
    expect(files.map(file => [file.path, file.status, file.diffOmitted])).toEqual([
      ["run.sh", "modified", true],
      ["vendored", "modified", true],
    ]);
    expect(blobReads).toEqual([]); // neither a gitlink nor a mode-only change loads content
  });

  it("handles a directory replaced by a file", async () => {
    const { source } = fakeSource(
      {
        [oid(30)]: [{ mode: "40000", name: "thing", oid: oid(11) }],
        [oid(31)]: [{ mode: "100644", name: "thing", oid: oid(4) }],
        [oid(11)]: trees[oid(11)],
      },
      blobs,
    );
    const files = await diffGitTrees(source, oid(30), oid(31));
    expect(files.map(file => [file.path, file.status])).toEqual([
      ["thing/x.txt", "removed"],
      ["thing", "added"],
    ]);
  });

  it("shows a BOM-only content change instead of stripping it into an empty diff", async () => {
    const { source } = fakeSource(
      {
        [oid(30)]: [{ mode: "100644", name: "a.txt", oid: oid(1) }],
        [oid(31)]: [{ mode: "100644", name: "a.txt", oid: oid(2) }],
      },
      { [oid(1)]: text("hello\n"), [oid(2)]: text("\uFEFFhello\n") },
    );
    const files = await diffGitTrees(source, oid(30), oid(31));
    expect(files).toHaveLength(1);
    expect(files[0].diffOmitted).toBe(false);
    expect(files[0].hunks[0].lines).toEqual([
      { kind: "removed", text: "hello", oldLineNumber: 1 },
      { kind: "added", text: "\uFEFFhello", newLineNumber: 1 },
    ]);
  });

  it("throws TreeUnavailableError when a needed tree cannot be loaded", async () => {
    const { source } = fakeSource({ [oid(30)]: [{ mode: "40000", name: "sub", oid: oid(99) }] }, {});
    await expect(diffGitTrees(source, oid(30), null)).rejects.toThrow(TreeUnavailableError);
  });
});

describe("changedPathsBetweenTrees", () => {
  it("lists changed paths without loading any blob", async () => {
    const trees: Record<string, GitTreeEntry[]> = {
      [oid(10)]: [
        { mode: "100644", name: "a.txt", oid: oid(1) },
        { mode: "40000", name: "sub", oid: oid(11) },
      ],
      [oid(20)]: [
        { mode: "100644", name: "a.txt", oid: oid(2) },
        { mode: "40000", name: "sub", oid: oid(21) },
      ],
      [oid(11)]: [{ mode: "100644", name: "x.txt", oid: oid(3) }],
      [oid(21)]: [{ mode: "100644", name: "x.txt", oid: oid(4) }],
    };
    const { source, blobReads } = fakeSource(trees, {});
    expect(await changedPathsBetweenTrees(source, oid(10), oid(20)))
      .toEqual(["a.txt", "sub/x.txt"]);
    expect(blobReads).toEqual([]);
  });
});
