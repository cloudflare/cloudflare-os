import { promises as fsp } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const git = vi.hoisted(() => ({
  fetch: vi.fn(),
  listFiles: vi.fn(),
  listServerRefs: vi.fn(),
  readBlob: vi.fn(),
}));

vi.mock("isomorphic-git", () => ({
  clone: vi.fn(),
  fetch: git.fetch,
  listFiles: git.listFiles,
  listServerRefs: git.listServerRefs,
  readBlob: git.readBlob,
  resolveRef: vi.fn(),
}));

vi.mock("isomorphic-git/http/web", () => ({ request: vi.fn() }));

import { readArtifactRepoDocuments } from "../src/artifact-sync.js";

const dir = "/tmp/artifacts/fetch-test";

afterEach(async () => {
  vi.clearAllMocks();
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("artifact repository refresh", () => {
  it("reads the fetched commit instead of stale local HEAD", async () => {
    await fsp.mkdir(`${dir}/.git`, { recursive: true });
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
      "fetch-test",
      "https://example.com/repo.git",
      "main",
      "old-commit",
    );

    expect(result).toMatchObject({ changed: true, commit: "new-commit" });
    expect(git.listFiles).toHaveBeenCalledWith(expect.objectContaining({ ref: "new-commit" }));
    expect(git.readBlob).toHaveBeenCalledWith(expect.objectContaining({ oid: "new-commit" }));
    expect(revokeToken).toHaveBeenCalledWith("token");
  });
});
