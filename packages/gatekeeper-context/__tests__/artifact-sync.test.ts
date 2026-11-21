import { describe, expect, it } from "vitest";
import {
  gitBlobHash, readArtifactRepoDocuments, type ArtifactContextDocument, type ArtifactRepoReadResult,
} from "../src/artifact-sync.js";
import { MAX_DOCUMENT_BODY_BYTES } from "../src/context-types.js";
import { FakeGitRepo, artifactsError } from "./fake-git-repo.js";

type Read = { result: ArtifactRepoReadResult; staged: Record<string, string> };

async function read(fake: FakeGitRepo, currentCommit?: string, held = new Map<string, string>()): Promise<Read> {
  let artifacts = { get: async () => fake.repo() } as unknown as Artifacts;
  let staged: ArtifactContextDocument[] = [];
  let result = await readArtifactRepoDocuments(artifacts, "repo", "main", currentCommit, {
    heldBlobHashes: async () => new Map([...held].map(([path, hash]) => [path, new Set([hash])])),
    stage: document => staged.push(document),
  });
  return {
    result,
    staged: Object.fromEntries(staged.map(doc => [doc.path, new TextDecoder().decode(doc.body)])),
  };
}

function fileHashes(result: ArtifactRepoReadResult): Map<string, string> {
  if (!result.changed) throw new Error("Expected the sync to find a new commit.");
  return result.files;
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

    expect((await read(fake, commit)).result).toEqual({ commit, changed: false });
    expect(fake.logRefs).toEqual(["refs/heads/main"]);
    expect(fake.treeReads).toEqual([]);
    expect(fake.disposed).toBe(1);
  });

  it("empties the collection once when the branch has no commits", async () => {
    let fake = new FakeGitRepo();

    expect((await read(fake, "old-commit")).result)
      .toEqual({ commit: "", changed: true, files: new Map() });
    expect((await read(fake, "")).result).toEqual({ commit: "", changed: false });
  });

  it("stages every file in the tree, except submodules", async () => {
    let fake = new FakeGitRepo();
    let commit = await fake.push("main", {
      "readme.md": "# Hi",
      "docs/deep/guide.md": "deep",
      "run.sh": { exec: "#!/bin/sh" },
      "latest.md": { symlink: "readme.md" },
      "vendor/lib": { gitlink: "1".repeat(40) },
    });

    let { result, staged } = await read(fake);

    expect(result).toMatchObject({ commit, changed: true });
    expect([...fileHashes(result).keys()].toSorted())
      .toEqual(["docs/deep/guide.md", "latest.md", "readme.md", "run.sh"]);
    expect(fileHashes(result).get("readme.md")).toBe(await fake.hashOf("# Hi"));
    expect(staged).toEqual({
      "readme.md": "# Hi",
      "docs/deep/guide.md": "deep",
      "run.sh": "#!/bin/sh",
      "latest.md": "readme.md",
    });
    expect(fake.blobReads).not.toContain("1".repeat(40));
  });

  it("reads only the files whose blob differs from the held copy", async () => {
    let fake = new FakeGitRepo();
    let first = await fake.push("main", { "a.md": "a", "docs/b.md": "b", "c.md": "c" });
    let held = new Map([
      ["a.md", await fake.hashOf("a")],
      ["docs/b.md", await fake.hashOf("b")],
      ["c.md", await fake.hashOf("c")],
    ]);
    await fake.push("main", { "a.md": "a", "docs/b.md": "b, edited", "d.md": "d" });
    fake.blobReads = [];

    let { result, staged } = await read(fake, first, held);

    expect([...fileHashes(result).keys()].toSorted()).toEqual(["a.md", "d.md", "docs/b.md"]);
    expect(staged).toEqual({ "docs/b.md": "b, edited", "d.md": "d" });
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

    expect((await read(fake)).staged).toEqual({ "small.md": "small" });

    fake.blobErrors.set(await fake.hashOf("small"), artifactsError("INTERNAL_ERROR"));
    await expect(read(fake)).rejects.toThrow("INTERNAL_ERROR");
  });

  it("starts no reads after one fails, and finishes those in flight before failing", async () => {
    let fake = new FakeGitRepo();
    let files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`file-${i}.md`] = `file ${i}`;
    await fake.push("main", files);
    fake.blobErrors.set(await fake.hashOf("file 0"), artifactsError("INTERNAL_ERROR"));
    fake.blobDelay = () => new Promise(resolve => setTimeout(resolve, 5));
    let artifacts = { get: async () => fake.repo() } as unknown as Artifacts;
    let staged: string[] = [];

    await expect(readArtifactRepoDocuments(artifacts, "repo", "main", undefined, {
      heldBlobHashes: async () => new Map(),
      stage: document => staged.push(document.path),
    })).rejects.toThrow("INTERNAL_ERROR");
    let atFailure = { reads: fake.blobReads.length, staged: [...staged] };
    // A read still running after the failure could stage a stale file over a later sync's copy.
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(atFailure).toEqual({ reads: 2, staged: ["file-1.md"] });
    expect({ reads: fake.blobReads.length, staged }).toEqual(atFailure);
  });

  it("reads at most two files at a time, since each can be 32 MiB", async () => {
    let fake = new FakeGitRepo();
    let files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`file-${i}.md`] = `file ${i}`;
    await fake.push("main", files);
    fake.blobDelay = () => new Promise(resolve => setTimeout(resolve, 1));

    expect(Object.keys((await read(fake)).staged)).toHaveLength(12);
    expect(fake.maxBlobReadsInFlight).toBe(2);
  });
});
