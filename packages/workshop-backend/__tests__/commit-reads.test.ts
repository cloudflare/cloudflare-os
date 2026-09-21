// The client-facing commit reads (Overseer.listTree / readFilesAtCommit) through the real
// OverseerInterface and UseOverseerInterface classes: oid validation, the per-call path cap, and
// the use-role denial. The read semantics themselves are covered by git-cache.test.ts; this file
// covers the RPC surface -- and, because capnweb-validate is *not* mocked here, importing
// overseer.ts compiles the generated validators, including the recursive TreeNode return shape.

import { describe, expect, it } from "vitest";
import { createTypedStorage } from "@gadgets/typed-storage";
import { MAX_READ_FILES_PER_CALL } from "@gadgets/workshop-shared/api";
import { WorkspaceGitCache, gitObjectMetadataCollection } from "../src/git-cache";
import { gitObjectsCollection } from "../src/git-store";
import { makeMockStorage } from "./mock-storage";
import { openFakeOverseer } from "./fixtures";
import { COMMIT_1, FIXTURE_OBJECTS, PACKED_OIDS, b64Bytes } from "./git-cache-fixtures";

// A real git cache over the fixture repo (fully local, so nothing pulls), forged into the fake
// overseer's impl -- the only member the reads dereference.
async function openWithFixtureRepo(role: "build" | "use") {
  let storage = createTypedStorage(makeMockStorage(), {
    collections: {
      gitObjects: gitObjectsCollection(),
      gitObjectMetadata: gitObjectMetadataCollection(),
    },
  });
  let gitCache = new WorkspaceGitCache(storage, {
    pull: async () => { throw new Error("test: nothing should pull"); },
  });
  for (let object of FIXTURE_OBJECTS) {
    if (PACKED_OIDS.includes(object.oid)) {
      await gitCache.putFromGatekeeper(1, object.type, b64Bytes(object.payload));
    }
  }
  return openFakeOverseer({}, { role, impl: { gitCache } });
}

describe("commit reads over the Overseer interface", () => {
  it("serves the nested tree and file contents to a build collaborator", async () => {
    let client = await openWithFixtureRepo("build");
    let tree = await client.listTree(COMMIT_1);
    expect(tree.map(node => [node.name, node.kind])).toStrictEqual([
      ["README.md", "file"], ["docs", "dir"], ["link.md", "symlink"], ["run.sh", "executable"],
      ["src", "dir"], ["vendored", "submodule"],
    ]);
    expect(await client.readFilesAtCommit(COMMIT_1, ["README.md", "nope.txt"])).toStrictEqual([
      ["README.md", { kind: "text", text: "# Fixture\n" }],
      ["nope.txt", { kind: "absent" }],
    ]);
  });

  it("validates the commit id before touching the store", async () => {
    let client = await openWithFixtureRepo("build");
    await expect(client.listTree("HEAD")).rejects.toThrow("Invalid commit id.");
    await expect(client.listTree(COMMIT_1.slice(0, 12))).rejects.toThrow("Invalid commit id.");
    await expect(client.readFilesAtCommit("../../etc", ["README.md"]))
        .rejects.toThrow("Invalid commit id.");
  });

  it("caps the paths per readFilesAtCommit call", async () => {
    let client = await openWithFixtureRepo("build");
    let paths = Array.from({ length: MAX_READ_FILES_PER_CALL + 1 }, (_, i) => `f${i}.txt`);
    await expect(client.readFilesAtCommit(COMMIT_1, paths)).rejects.toThrow(/Too many paths/);
    // Exactly the cap is fine.
    expect(await client.readFilesAtCommit(COMMIT_1, paths.slice(1)))
        .toHaveLength(MAX_READ_FILES_PER_CALL);
  });

  it("denies both reads to a use collaborator", async () => {
    let client = await openWithFixtureRepo("use");
    await expect(client.listTree(COMMIT_1)).rejects.toThrow(/Unauthorized/);
    await expect(client.readFilesAtCommit(COMMIT_1, ["README.md"])).rejects.toThrow(/Unauthorized/);
  });
});
