// The client-facing commit reads (Overseer.listTree / readFilesAtCommit / listChangedPaths /
// readBlob / getPushReview) through the real OverseerInterface class: oid validation, the per-call
// path cap, the order of listed paths, which actions have a push review, and the "use" role's
// denial. The read semantics themselves are covered by
// git-cache.test.ts; this file covers the RPC surface -- and, because
// capnweb-validate is *not* mocked here, importing overseer.ts compiles the generated validators,
// including the recursive TreeNode return shape.

import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { MAX_READ_FILES_PER_CALL, type Overseer } from "@gadgets/workshop-shared/api";
import type { FileContent } from "@gadgets/workshop-shared/code-change";
import type { OverseerDurableObject } from "../src/overseer.js";
import { WorkspaceGitCache } from "../src/git-cache";
import { makeOverseerStorage } from "../src/storage-schema/overseer-storage";
import { makeMockStorage } from "./mock-storage";
import { openFakeOverseer, putAction } from "./fixtures";
import { COMMIT_1, COMMIT_2, FIXTURE_OBJECTS, PACKED_OIDS, TREE_1, b64Bytes }
  from "./git-cache-fixtures";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// A real git cache over the fixture repo, forged into the fake overseer's impl -- the only member
// the reads dereference. All of it is local but the `remote` objects, which gatekeeper 1 provides
// when pulled; any other pull fails.
async function openWithFixtureRepo(remote: readonly string[] = []) {
  let storage = makeOverseerStorage(makeMockStorage());
  let gitCache: WorkspaceGitCache = new WorkspaceGitCache(storage, {
    pull: async (gatekeeperId, oids) => {
      for (let oid of oids) {
        let object = FIXTURE_OBJECTS.find(candidate => candidate.oid === oid);
        if (object === undefined || !remote.includes(oid)) {
          throw new Error(`test: unexpected pull of ${oid}`);
        }
        gitCache.putFromGatekeeper(gatekeeperId, object.type, b64Bytes(object.payload));
      }
    },
  });
  for (let object of FIXTURE_OBJECTS) {
    if (PACKED_OIDS.includes(object.oid) && !remote.includes(object.oid)) {
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

  // The client's file cache is page-wide, so it can hold a blob entry that another workspace
  // fetched, for a commit this workspace mounts but has not read the file of.
  it("pulls a blob the workspace does not hold yet", async () => {
    let readme = "ca69e6d08b5b8bb4f11a74f9695e329c203cbfd8";  // README.md at COMMIT_1
    let client = await openWithFixtureRepo([readme]);
    let stream = await client.readBlob(readme);
    expect(new TextDecoder().decode(await new Response(stream).arrayBuffer())).toBe("# Fixture\n");
  });
});

// A parentless commit of the files, through the Overseer's own store.
async function commitFiles(impl: { gitCache: WorkspaceGitCache },
                           files: Record<string, FileContent>): Promise<string> {
  return await impl.gitCache.writeFilesAsCommit(new Map(Object.entries(files)), {
    parents: [],
    author: { name: "Alice", email: "alice@example.com" },
    message: "test commit",
    timestamp: new Date(1700000000_000),
  });
}

describe("listChangedPaths and readBlob over the Overseer interface", () => {
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

  it("reads back the blob a binary file's entry names", async () => {
    await withClient(async (impl, client) => {
      let png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
      let commit = await commitFiles(impl, { "logo.png": impl.gitCache.writeBlob(png) });
      let [[, file]] = await client.readFilesAtCommit(commit, ["logo.png"]);
      if (file.kind !== "blob") throw new Error(`expected a blob entry, got ${file.kind}`);
      expect(file.blob.byteLength).toBe(png.byteLength);
      let stream = await client.readBlob(file.blob.oid);
      expect(new Uint8Array(await new Response(stream).arrayBuffer())).toStrictEqual(png);
      await expect(client.readBlob("0".repeat(40))).rejects.toThrow(/Could not pull git object/);
      await expect(client.readBlob("HEAD")).rejects.toThrow(/Invalid git object id/);
    });
  });
});

describe("getPushReview over the Overseer interface", () => {
  const PUSH = 1, PLAIN_ACTION = 2, OBSERVATION = 3, HOOK = 4, APPROVED_PUSH = 5;

  // A workspace whose action log holds one of each kind of record. The pushes send `head`, a
  // commit made here on a commit gatekeeper 1's remote has.
  async function openWithActions(role: "build" | "use" = "build") {
    let storage = makeOverseerStorage(makeMockStorage());
    let gitCache = new WorkspaceGitCache(storage, {
      pull: async () => { throw new Error("test: unexpected pull"); },
    });
    let base = FIXTURE_OBJECTS.find(object => object.oid === COMMIT_1)!;
    await gitCache.putFromGatekeeper(1, base.type, b64Bytes(base.payload));
    let head = gitCache.writeCommitForTree(TREE_1, {
      parents: [COMMIT_1],
      author: { name: "Alice", email: "alice@example.com" },
      message: "local work",
      timestamp: new Date(1700000000_000),
    });
    storage.gatekeepers.put({ id: 1, class: {} as any });
    putAction(storage, PLAIN_ACTION);
    putAction(storage, OBSERVATION, { type: "observation" });
    putAction(storage, HOOK, { type: "bindHook" });
    for (let [id, state] of [[PUSH, "pending"], [APPROVED_PUSH, "approved"]] as const) {
      putAction(storage, id, { state });
      let record = storage.actions.get(id)!;
      if (record.type === "action") record.description.pushedCommits = [head];
      storage.actions.put(record);
    }
    gitCache.markPushClosure(1, PUSH, [head]);
    let client = await openFakeOverseer(storage, { role, impl: { gitCache } });
    return { head, gitCache, client, storage };
  }

  it("returns a page of what a pending push will send", async () => {
    let { head, gitCache, client } = await openWithActions();
    let text = new TextDecoder().decode(gitCache.readLocalObject(head)!.payload);
    expect(await client.getPushReview(PUSH)).toStrictEqual({
      entries: [{ kind: "commit", oid: head, parents: [COMMIT_1], size: text.length, text }],
      objectCount: 1,
      stackedOn: [],
    });
    expect((await client.getPushReview(PUSH, 1)).entries).toStrictEqual([]);
  });

  it("refuses an action that is not a pending push", async () => {
    let { client } = await openWithActions();
    for (let id of [99, PLAIN_ACTION, OBSERVATION, HOOK, APPROVED_PUSH]) {
      await expect(client.getPushReview(id)).rejects.toThrow(`Action ${id} is not a pending push.`);
      // Whatever the cursor: the action is checked first.
      await expect(client.getPushReview(id, -1))
          .rejects.toThrow(`Action ${id} is not a pending push.`);
    }
  });

  it("refuses a push whose connection was removed, rather than say it sends nothing", async () => {
    let { gitCache, client, storage } = await openWithActions();
    // What removeGatekeeper() leaves: the record still pending, its marks cleared.
    gitCache.clearPushMarks(PUSH);
    storage.gatekeepers.delete(1);
    await expect(client.getPushReview(PUSH)).rejects.toThrow(
        `Action ${PUSH} can never be applied: the connection it was submitted through has been ` +
        "removed from this workspace.");
  });

  it("refuses a cursor that is not a count of entries", async () => {
    let { client } = await openWithActions();
    for (let cursor of [-1, 1.5]) {
      await expect(client.getPushReview(PUSH, cursor)).rejects.toThrow("Invalid cursor.");
    }
  });

  it("is denied to a \"use\" collaborator", async () => {
    let { client } = await openWithActions("use");
    await expect(client.getPushReview(PUSH)).rejects.toThrow(/^Unauthorized/);
  });
});
