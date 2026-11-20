import { describe, expect, it } from "vitest";
import { gitBlobHash, readArtifactRepoDocuments, type ArtifactRepoReadResult } from "../src/artifact-sync.js";
import { MAX_DOCUMENT_BODY_BYTES } from "../src/context-types.js";
import { FakeGitRepo, artifactsError } from "./fake-git-repo.js";

function read(
    fake: FakeGitRepo, currentCommit?: string, stored = new Map<string, string>(),
): Promise<ArtifactRepoReadResult> {
  let artifacts = { get: async () => fake.repo() } as unknown as Artifacts;
  return readArtifactRepoDocuments(artifacts, "repo", "main", currentCommit, async () => stored);
}

function changed(result: ArtifactRepoReadResult) {
  if (!result.changed) throw new Error("Expected the sync to find a new commit.");
  return {
    commit: result.commit,
    unchanged: [...result.unchanged].toSorted(),
    documents: Object.fromEntries(result.documents.map(doc => [doc.path, new TextDecoder().decode(doc.body)])),
  };
}

describe("reading a git-backed collection's repo", () => {
  it("hashes blobs as git does", async () => {
    // `git hash-object` of a file holding "# Readme\n".
    expect(await gitBlobHash(new TextEncoder().encode("# Readme\n")))
      .toBe("f3954314c1026028e77ea3a765aadefa67b45195");
  });

  it("reads nothing more while the branch tip is the stored commit", async () => {
    let fake = new FakeGitRepo();
    let commit = await fake.push("main", { "readme.md": "# Hi" });

    expect(await read(fake, commit)).toEqual({ commit, changed: false });
    expect(fake.logRefs).toEqual(["refs/heads/main"]);
    expect(fake.treeReads).toEqual([]);
    expect(fake.disposed).toBe(1);
  });

  it("empties the collection once when the branch has no commits", async () => {
    let fake = new FakeGitRepo();

    expect(await read(fake, "old-commit"))
      .toEqual({ commit: "", changed: true, unchanged: new Set(), documents: [] });
    expect(await read(fake, "")).toEqual({ commit: "", changed: false });
  });

  it("reads every file in the tree, except submodules", async () => {
    let fake = new FakeGitRepo();
    let commit = await fake.push("main", {
      "readme.md": "# Hi",
      "docs/deep/guide.md": "deep",
      "run.sh": { exec: "#!/bin/sh" },
      "latest.md": { symlink: "readme.md" },
      "vendor/lib": { gitlink: "1".repeat(40) },
    });

    let result = await read(fake);

    expect(changed(result)).toEqual({
      commit,
      unchanged: [],
      documents: {
        "readme.md": "# Hi",
        "docs/deep/guide.md": "deep",
        "run.sh": "#!/bin/sh",
        "latest.md": "readme.md",
      },
    });
    expect(result.changed && result.documents.find(doc => doc.path === "readme.md")?.gitBlobHash)
      .toBe(await fake.hashOf("# Hi"));
    expect(fake.blobReads).not.toContain("1".repeat(40));
  });

  it("reads only the files whose blob changed", async () => {
    let fake = new FakeGitRepo();
    let first = await fake.push("main", { "a.md": "a", "docs/b.md": "b", "c.md": "c" });
    let stored = new Map([
      ["a.md", await fake.hashOf("a")],
      ["docs/b.md", await fake.hashOf("b")],
      ["c.md", await fake.hashOf("c")],
    ]);
    await fake.push("main", { "a.md": "a", "docs/b.md": "b, edited", "d.md": "d" });
    fake.blobReads = [];

    expect(changed(await read(fake, first, stored))).toMatchObject({
      unchanged: ["a.md"],
      documents: { "docs/b.md": "b, edited", "d.md": "d" },
    });
    expect(fake.blobReads.toSorted())
      .toEqual([await fake.hashOf("b, edited"), await fake.hashOf("d")].toSorted());
  });

  it("skips files too large to keep, and fails on other read errors", async () => {
    let fake = new FakeGitRepo();
    await fake.push("main", {
      "big.bin": new Uint8Array(MAX_DOCUMENT_BODY_BYTES + 1),
      "huge.bin": "stands in for a blob Artifacts won't buffer",
      "small.md": "small",
    });
    fake.blobErrors.set(await fake.hashOf("stands in for a blob Artifacts won't buffer"),
        artifactsError("MEMORY_LIMIT"));

    expect(changed(await read(fake)).documents).toEqual({ "small.md": "small" });

    fake.blobErrors.set(await fake.hashOf("small"), artifactsError("INTERNAL_ERROR"));
    await expect(read(fake)).rejects.toThrow("INTERNAL_ERROR");
  });

  it("refuses a sync that would hold too much changed content at once", async () => {
    let fake = new FakeGitRepo();
    let files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) files[`file-${i}.bin`] = `file ${i}`;
    await fake.push("main", files);
    // Each blob is just under the document limit; together they pass the per-sync limit.
    for (let [hash, blob] of fake.blobs) {
      fake.blobs.set(hash, { size: MAX_DOCUMENT_BODY_BYTES, arrayBuffer: blob.arrayBuffer.bind(blob) });
    }

    await expect(read(fake)).rejects.toThrow("Repository too large");
  });
});
