// The client-facing commit reads (Overseer.listTree / readFilesAtCommit / listChangedPaths)
// through the real OverseerInterface class: oid validation, the per-call path cap, the order of
// listed paths, and the "use" role's denial. The read semantics themselves are covered by
// git-cache.test.ts; this file covers the RPC surface -- and, because
// capnweb-validate is *not* mocked here, importing overseer.ts compiles the generated validators,
// including the recursive TreeNode return shape.

import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { MAX_READ_FILES_PER_CALL, type Overseer } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import { WorkspaceGitCache } from "../src/git-cache";
import { makeOverseerStorage } from "../src/storage-schema/overseer-storage";
import { makeMockStorage } from "./mock-storage";
import { openFakeOverseer } from "./fixtures";
import { COMMIT_1, COMMIT_2, FIXTURE_OBJECTS, PACKED_OIDS, b64Bytes }
  from "./git-cache-fixtures";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// A real git cache over the fixture repo (fully local, so nothing pulls), forged into the fake
// overseer's impl -- the only member the reads dereference.
async function openWithFixtureRepo() {
  let storage = makeOverseerStorage(makeMockStorage());
  let gitCache = new WorkspaceGitCache(storage, {
    pull: async () => { throw new Error("test: nothing should pull"); },
  });
  for (let object of FIXTURE_OBJECTS) {
    if (PACKED_OIDS.includes(object.oid)) {
      await gitCache.putFromGatekeeper(1, object.type, b64Bytes(object.payload));
    }
  }
  return openFakeOverseer({}, { impl: { gitCache } });
}

describe("commit reads over the Overseer interface", () => {
  it("serves the nested tree and file contents to a build collaborator", async () => {
    let client = await openWithFixtureRepo();
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
    let client = await openWithFixtureRepo();
    await expect(client.listTree("HEAD")).rejects.toThrow("Invalid commit id.");
    await expect(client.listTree(COMMIT_1.slice(0, 12))).rejects.toThrow("Invalid commit id.");
    await expect(client.readFilesAtCommit("../../etc", ["README.md"]))
        .rejects.toThrow("Invalid commit id.");
  });

  it("caps the paths per readFilesAtCommit call", async () => {
    let client = await openWithFixtureRepo();
    let paths = Array.from({ length: MAX_READ_FILES_PER_CALL + 1 }, (_, i) => `f${i}.txt`);
    await expect(client.readFilesAtCommit(COMMIT_1, paths)).rejects.toThrow(/Too many paths/);
    // Exactly the cap is fine.
    expect(await client.readFilesAtCommit(COMMIT_1, paths.slice(1)))
        .toHaveLength(MAX_READ_FILES_PER_CALL);
  });
});

// A parentless commit of the files, through the Overseer's own store.
async function commitFiles(impl: any, files: Record<string, string>): Promise<string> {
  return await impl.gitStore.writeFilesAsCommit(new Map(Object.entries(files)), {
    parents: [],
    author: { name: "Alice", email: "alice@example.com" },
    message: "test commit",
    timestamp: new Date(1700000000_000),
  });
}

describe("listChangedPaths over the Overseer interface", () => {
  // The real client interface, opened as its owner over a fresh Overseer.
  let doCounter = 0;
  async function withClient(fn: (impl: any, client: Overseer) => Promise<void>): Promise<void> {
    let stub = env.TEST_OVERSEER.getByName(`commit-reads-${++doCounter}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      let ownerId = impl.users.newUniqueId().toString();
      impl.ownerId = ownerId;
      impl.ensureAmbientCapsules = async () => {};
      impl.markOutputsDirty = () => {};
      using notifyClosed = new NativeRpcStub<() => void>(() => {});
      using client = await instance.open(ownerId, "owner-profile", notifyClosed);
      await fn(impl, client);
    });
  }

  it("lists the paths that differ, sorted, whichever commit comes first", async () => {
    await withClient(async (impl, client) => {
      let before = await commitFiles(impl, { "z.js": "z\n", "src/b.js": "b\n", "c.js": "c\n" });
      let after = await commitFiles(impl,
          { "z.js": "Z\n", "src/b.js": "b\n", "src/a.js": "a\n", "a.js": "a\n" });
      // The tree walk meets them as c.js, src/a.js, z.js, a.js: a name that only the second
      // tree has comes last.
      let expected = ["a.js", "c.js", "src/a.js", "z.js"];
      expect(await client.listChangedPaths(before, after)).toStrictEqual(expected);
      expect(await client.listChangedPaths(after, before)).toStrictEqual(expected);
      expect(await client.listChangedPaths(after, after)).toStrictEqual([]);
    });
  });

  it("validates both commit ids before touching the store", async () => {
    await withClient(async (impl, client) => {
      let commit = await commitFiles(impl, { "a.js": "a\n" });
      await expect(client.listChangedPaths("HEAD", commit)).rejects.toThrow("Invalid commit id.");
      await expect(client.listChangedPaths(commit, commit.slice(0, 12)))
          .rejects.toThrow("Invalid commit id.");
    });
  });

  it("is denied to a \"use\" collaborator", async () => {
    let client = await openFakeOverseer({}, { role: "use" });
    await expect(client.listChangedPaths(COMMIT_1, COMMIT_2)).rejects.toThrow(/^Unauthorized/);
  });
});
