import { promises as fsp } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const git = vi.hoisted(() => ({
  clone: vi.fn(),
  fetch: vi.fn(),
  listFiles: vi.fn(),
  listServerRefs: vi.fn(),
  readBlob: vi.fn(),
  resolveRef: vi.fn(),
}));

vi.mock("isomorphic-git", () => ({
  clone: git.clone,
  fetch: git.fetch,
  listFiles: git.listFiles,
  listServerRefs: git.listServerRefs,
  readBlob: git.readBlob,
  resolveRef: git.resolveRef,
}));

vi.mock("isomorphic-git/http/web", () => ({ request: vi.fn() }));

import { readArtifactRepoDocuments } from "../src/artifact-sync.js";

let artifactsDir: string;
let id: string;

beforeEach(async () => {
  await fsp.mkdir("/tmp/artifacts", { recursive: true });
  artifactsDir = await fsp.mkdtemp("/tmp/artifacts/fetch-test-");
  id = artifactsDir.slice("/tmp/artifacts/".length);
});

afterEach(async () => {
  vi.resetAllMocks();
  await fsp.rm(artifactsDir, { recursive: true, force: true });
});

describe("artifact repository refresh", () => {
  it("reads the fetched commit instead of stale local HEAD", async () => {
    await fsp.mkdir(`${artifactsDir}/.git`, { recursive: true });
    git.listServerRefs.mockResolvedValue([{ ref: "refs/heads/main", oid: "new-commit" }]);
    git.fetch.mockResolvedValue({ fetchHead: "new-commit" });
    git.listFiles.mockResolvedValue(["readme.md"]);
    git.readBlob.mockResolvedValue({ blob: new TextEncoder().encode("# Updated") });
    const revokeToken = vi.fn().mockResolvedValue(true);
    const artifacts = {
      async get() {
        return {
          async createToken() { return { id: "token", plaintext: "secret" }; },
          revokeToken,
        };
      },
    } as unknown as Artifacts;

    const result = await readArtifactRepoDocuments(
      artifacts,
      id,
      "https://example.com/repo.git",
      "main",
      "old-commit",
    );

    expect(result).toMatchObject({ changed: true, commit: "new-commit" });
    expect(git.listFiles).toHaveBeenCalledWith(expect.objectContaining({ ref: "new-commit" }));
    expect(git.readBlob).toHaveBeenCalledWith(expect.objectContaining({ oid: "new-commit" }));
    expect(revokeToken).toHaveBeenCalledWith("token");
  });

  it("reclones instead of returning an empty collection when fetch has no head", async () => {
    await fsp.mkdir(`${artifactsDir}/.git`, { recursive: true });
    git.listServerRefs.mockResolvedValue([{ ref: "refs/heads/main", oid: "new-commit" }]);
    git.fetch.mockResolvedValue({ fetchHead: null });
    git.resolveRef.mockResolvedValue("recloned-commit");
    git.listFiles.mockResolvedValue(["readme.md"]);
    git.readBlob.mockResolvedValue({ blob: new TextEncoder().encode("# Recovered") });
    const revokeToken = vi.fn().mockResolvedValue(true);
    const artifacts = {
      async get() {
        return {
          async createToken() { return { id: "token", plaintext: "secret" }; },
          revokeToken,
        };
      },
    } as unknown as Artifacts;

    const result = await readArtifactRepoDocuments(
      artifacts,
      id,
      "https://example.com/repo.git",
      "main",
      "old-commit",
    );

    expect(git.clone).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      changed: true,
      commit: "recloned-commit",
      documents: [{ path: "readme.md", body: new TextEncoder().encode("# Recovered") }],
    });
    expect(revokeToken).toHaveBeenCalledWith("token");
  });
});
