import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createTypedStorage } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { applyCodeChange, type CodeChange, type CodeContent }
  from "@gadgets/workshop-shared/code-change";
import type { GitOid, GitPullHints } from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "../src/overseer.js";
import { WorktreeSessionImpl, type WorktreeSessionHost } from "../src/worktree-session";
import type { WorktreeTurnAccess } from "../src/agent";
import { formatUnifiedDiff } from "../src/agent";
import { WorkspaceGitCache, gitObjectMetadataCollection } from "../src/git-cache";
import { GitStore, gitObjectsCollection } from "../src/git-store";
import { concatBytes } from "../src/git-codec";
import { makeMockStorage } from "./mock-storage";
import { COMMIT_1, FIXTURE_OBJECTS, PACKED_OIDS, b64Bytes } from "./git-cache-fixtures";
// Vite's ?raw import; resolved relative to this file, so the test below can compare the
// shipped text module against its source of truth.
// @ts-expect-error -- ?raw imports have no type declaration
import WORKTREE_DTS_SOURCE from "../src/worktree-binding.d.ts?raw";
// The text module workshop-backend ships -- a symlink to the .d.ts above (see
// worktreeAgentApiText in overseer.ts).
import WORKTREE_BINDING_TYPES from "../src/worktree-binding.txt";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// Exercises the programmatic Worktree binding (worktree-session.ts) against the real
// OverseerImpl: file operations over the overlay-over-base view (all five tree-entry modes),
// diff-based writes, grep (including the one-batched-pull fill of missing blobs), commit()'s
// squash semantics and step-barrier lifecycle, and diff() output. The turn half of the session
// (WorktreeTurnAccess) is implemented here by a harness mirroring runAgent's closures, driving
// the same barrier (commitAgentStep) the real turn does.

const USER: AiChatAuthorInfo = { type: "user", id: "alice@example.com", name: "Alice" };
const AGENT: AiChatAuthorInfo = { type: "agent", id: "some-model", name: "Agent" };
const USER_META = { profile: USER };

let doCounter = 0;
async function withImpl(fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`worktree-session-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await fn((instance as unknown as { impl: any }).impl);
  });
}

function addChat(impl: any, id: number): void {
  impl.storage.chatMeta.put(
      { id, title: "Chat", started: new Date(0), lastActive: new Date(id) });
}

// Loads the real-git fixture repo (all five entry modes) fully locally, so nothing pulls.
async function loadFixtureRepo(impl: any): Promise<void> {
  for (let object of FIXTURE_OBJECTS) {
    if (PACKED_OIDS.includes(object.oid)) {
      await impl.gitCache.putFromGatekeeper(999, object.type, b64Bytes(object.payload));
    }
  }
}

// The turn half of the session: runAgent's worktree closures, mirrored closely enough to drive
// WorktreeSessionImpl end to end -- a session-content overlay with removal tombstones, an
// appendChange that applies each change the way the step buffer does, and buffered commit
// advancements, all drained through the real barrier (impl.commitAgentStep).
function makeTurn(impl: any, chatId: number) {
  let content = new Map<number, Map<string, string>>();
  let removed = new Map<number, Set<string>>();
  let pins = new Map<number, string>();
  let changes: { change: CodeChange }[] = [];
  let commits: { worktreeId: number, commit: string, previousHead: string }[] = [];

  let access: WorktreeTurnAccess = {
    getPinBase: id => pins.get(id),
    getBufferedHead: id => commits.findLast(entry => entry.worktreeId === id)?.commit,
    getOverlayFiles: id => content.get(id) ?? new Map(),
    getRemovedPaths: id => removed.get(id) ?? new Set(),
    readFile: async (id, path) => {
      let existing = content.get(id)?.get(path);
      if (existing !== undefined) return existing;
      if (removed.get(id)?.has(path)) return undefined;
      let base = pins.get(id);
      if (base === undefined) return undefined;
      let text = await impl.readFileAtCommit(base, path);
      if (text === undefined) return undefined;
      let files = new Map(content.get(id));
      files.set(path, text);
      content.set(id, files);
      return text;
    },
    appendChange: (id, path, change) => {
      let one: CodeChange = { [id]: [[path, change]] };
      let updated: CodeContent = applyCodeChange(new Map([[id, content.get(id) ?? new Map()]]), one);
      content.set(id, new Map(updated.get(id)));
      if ("remove" in change) {
        let set = removed.get(id);
        if (set === undefined) removed.set(id, set = new Set());
        set.add(path);
      } else {
        removed.get(id)?.delete(path);
      }
      changes.push({ change: one });
    },
    appendCommit: (id, commit, previousHead) =>
        commits.push({ worktreeId: id, commit, previousHead }),
  };

  return {
    access,
    pins,
    bufferedChanges: changes,
    bufferedCommits: commits,
    session: (id: number) => new WorktreeSessionImpl(impl, id, access, USER),
    barrier: async () => impl.commitAgentStep(
        chatId, AGENT, [{ type: "message", message: "step" }],
        { changes: changes.splice(0), createdGadgets: [], createdWorktrees: [],
          addedBindings: [], worktreeCommits: commits.splice(0) }),
  };
}

// Creates a worktree through the barrier and returns a session over it.
async function createWorktreeSession(impl: any, chatId: number, commitRef: string) {
  let created = await impl.createWorktree("Repo", chatId, commitRef);
  await impl.commitAgentStep(chatId, AGENT, [{ type: "message", message: "create" }], {
    changes: [],
    createdGadgets: [],
    createdWorktrees: [{ worktreeId: created.id, title: created.title, bindingName: "REPO" }],
    addedBindings: [],
    worktreeCommits: [],
  });
  let turn = makeTurn(impl, chatId);
  turn.pins.set(created.id, created.baseCommit);
  return { id: created.id, baseCommit: created.baseCommit, turn,
           session: turn.session(created.id) };
}

async function commitFiles(
    impl: any, files: Record<string, string>, parents: string[] = []): Promise<string> {
  return await impl.gitStore.writeFilesAsCommit(new Map(Object.entries(files)), {
    parents,
    author: { name: "Alice", email: "alice@example.com" },
    message: "test commit",
    timestamp: new Date(1700000000_000),
  });
}

// A WorkspaceGitCache outside the DO with a mock pull source (`pull` gets the cache so it can
// deliver objects), plus a factory for read-only sessions over it -- an empty overlay over
// `pinBase` -- so tests can observe or fail pulls precisely.
function makeLocalHarness(
    pull: (cache: WorkspaceGitCache, oids: GitOid[], hints: GitPullHints) => Promise<void>) {
  let storage = createTypedStorage(makeMockStorage(), {
    collections: {
      gitObjects: gitObjectsCollection(),
      gitObjectMetadata: gitObjectMetadataCollection(),
    },
  });
  let cache: WorkspaceGitCache = new WorkspaceGitCache(storage, {
    pull: (_gatekeeperId, oids, hints) => pull(cache, oids, hints),
  });
  let gitStore = new GitStore(storage.gitObjects);
  let session = (pinBase: string): WorktreeSessionImpl => {
    let host: WorktreeSessionHost = {
      gitCache: cache,
      gitStore,
      getWorktreeRecord: () => ({ headCommit: pinBase }),
    };
    let access: WorktreeTurnAccess = {
      getPinBase: () => pinBase,
      getBufferedHead: () => undefined,
      getOverlayFiles: () => new Map(),
      getRemovedPaths: () => new Set(),
      readFile: async (_id, path) => cache.readFileAtCommitIfExists(pinBase, path),
      appendChange: () => { throw new Error("read-only test"); },
      appendCommit: () => { throw new Error("read-only test"); },
    };
    return new WorktreeSessionImpl(host, 5, access, USER);
  };
  return { cache, gitStore, session };
}

describe("listFiles", () => {
  it("surfaces all five entry kinds, non-recursively and recursively",
      () => withImpl(async impl => {
    addChat(impl, 1);
    await loadFixtureRepo(impl);
    let { session } = await createWorktreeSession(impl, 1, COMMIT_1);

    expect(await session.listFiles()).toEqual([
      { path: "README.md", kind: "file" },
      { path: "docs", kind: "dir" },
      { path: "link.md", kind: "symlink" },
      { path: "run.sh", kind: "executable" },
      { path: "src", kind: "dir" },
      { path: "vendored", kind: "submodule" },
    ]);
    expect(await session.listFiles("src")).toEqual([
      { path: "src/big.txt", kind: "file" },
      { path: "src/main.js", kind: "file" },
      { path: "src/util.js", kind: "file" },
    ]);
    let recursive = await session.listFiles(undefined, { recursive: true });
    expect(recursive).toContainEqual({ path: "docs/naïve.md", kind: "file" });
    expect(recursive).toContainEqual({ path: "src/util.js", kind: "file" });
    await expect(session.listFiles("README.md")).rejects.toThrow(/not a directory/);
    await expect(session.listFiles("nope")).rejects.toThrow(/no such directory/);
  }));

  it("overlays writes and removals: new files (and their directories) appear, deletions vanish",
      () => withImpl(async impl => {
    addChat(impl, 1);
    await loadFixtureRepo(impl);
    let { session } = await createWorktreeSession(impl, 1, COMMIT_1);

    await session.writeFile("notes/todo.txt", "todo\n");
    await session.deleteFile("README.md");

    let root = await session.listFiles();
    expect(root).toContainEqual({ path: "notes", kind: "dir" });
    expect(root.some(entry => entry.path === "README.md")).toBe(false);
    let recursive = await session.listFiles(undefined, { recursive: true });
    expect(recursive).toContainEqual({ path: "notes/todo.txt", kind: "file" });
    expect(await session.listFiles("notes")).toEqual(
        [{ path: "notes/todo.txt", kind: "file" }]);
  }));

  it("prunes directories hollowed out by deletions (git has no empty directories)",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, {
      "top.txt": "top\n", "a/side.txt": "side\n", "a/b/deep.txt": "deep\n" });
    let { session } = await createWorktreeSession(impl, 1, c1);

    // Deleting a/b's only file prunes a/b but not a (a/side.txt survives).
    await session.deleteFile("a/b/deep.txt");
    expect(await session.listFiles("a")).toEqual([{ path: "a/side.txt", kind: "file" }]);
    let recursive = await session.listFiles(undefined, { recursive: true });
    expect(recursive.some(entry => entry.path === "a/b")).toBe(false);
    expect(recursive).toContainEqual({ path: "a", kind: "dir" });

    // Deleting the rest prunes the whole chain, from every view; the pruned directories are
    // gone outright, like the tree commit() would write.
    await session.deleteFile("a/side.txt");
    expect(await session.listFiles()).toEqual([{ path: "top.txt", kind: "file" }]);
    expect(await session.listFiles(undefined, { recursive: true }))
        .toEqual([{ path: "top.txt", kind: "file" }]);
    await expect(session.listFiles("a")).rejects.toThrow("a: no such directory");
    await expect(session.listFiles("a/b")).rejects.toThrow("a/b: no such directory");

    // An overlay write under a pruned directory resurrects it.
    await session.writeFile("a/b/new.txt", "new\n");
    expect(await session.listFiles("a")).toEqual([{ path: "a/b", kind: "dir" }]);
    expect(await session.listFiles()).toContainEqual({ path: "a", kind: "dir" });
  }));

  it("a directory kept alive only by a symlink survives its files' deletion",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let linkBlob = await impl.gitCache.putFromGatekeeper(
        999, "blob", new TextEncoder().encode("target"));
    let fileBlob = await impl.gitCache.putFromGatekeeper(
        999, "blob", new TextEncoder().encode("x\n"));
    let subTree = await impl.gitCache.putFromGatekeeper(999, "tree", treePayload([
      { mode: "100644", name: "doomed.txt", oid: fileBlob },
      { mode: "120000", name: "link", oid: linkBlob },
    ]));
    let rootTree = await impl.gitCache.putFromGatekeeper(999, "tree", treePayload([
      { mode: "40000", name: "d", oid: subTree },
      { mode: "100644", name: "keep.txt", oid: fileBlob },
    ]));
    let commitOid = await impl.gitCache.putFromGatekeeper(
        999, "commit", commitPayload(rootTree, [], "symlink fixture"));
    let { session } = await createWorktreeSession(impl, 1, commitOid);

    await session.deleteFile("d/doomed.txt");
    expect(await session.listFiles("d")).toEqual([{ path: "d/link", kind: "symlink" }]);
    expect(await session.listFiles()).toContainEqual({ path: "d", kind: "dir" });
  }));
});

describe("file operations", () => {
  it("reads through the overlay, with descriptive errors for special entries",
      () => withImpl(async impl => {
    addChat(impl, 1);
    await loadFixtureRepo(impl);
    let { session } = await createWorktreeSession(impl, 1, COMMIT_1);

    expect(await session.readFile("src/util.js")).toBe("export const answer = 42;\n");
    await expect(session.readFile("missing.txt")).rejects.toThrow("missing.txt: no such file");
    await expect(session.readFile("link.md")).rejects.toThrow(
        "link.md is a symlink to README.md");
    await expect(session.readFile("vendored")).rejects.toThrow(/submodule \(gitlink\)/);

    await session.writeFile("fresh.txt", "hello\n");
    expect(await session.readFile("fresh.txt")).toBe("hello\n");
    await session.deleteFile("fresh.txt");
    await expect(session.readFile("fresh.txt")).rejects.toThrow("fresh.txt: no such file");
  }));

  it("writeFile emits a minimal edit for readable bases and a set for new files",
      () => withImpl(async impl => {
    addChat(impl, 1);
    await loadFixtureRepo(impl);
    let { session, turn } = await createWorktreeSession(impl, 1, COMMIT_1);

    await session.writeFile("src/util.js", "export const answer = 43;\n");
    let [path, change] = Object.values(turn.bufferedChanges.at(-1)!.change)[0][0];
    expect(path).toBe("src/util.js");
    expect("edit" in (change as object)).toBe(true);

    await session.writeFile("brand-new.txt", "new\n");
    [path, change] = Object.values(turn.bufferedChanges.at(-1)!.change)[0][0];
    expect(path).toBe("brand-new.txt");
    expect(change).toEqual({ set: "new\n" });

    // A no-op write records nothing.
    let buffered = turn.bufferedChanges.length;
    await session.writeFile("brand-new.txt", "new\n");
    expect(turn.bufferedChanges.length).toBe(buffered);
  }));

  it("writeFile falls back to a whole-file set over an unreadable (binary) base",
      () => withImpl(async impl => {
    addChat(impl, 1);
    // A hand-built commit whose tree holds a binary blob (NUL byte).
    let blob = new Uint8Array([0x89, 0x50, 0x00, 0x47]);
    let blobOid = await impl.gitCache.putFromGatekeeper(999, "blob", blob);
    let treeOid = await impl.gitCache.putFromGatekeeper(999, "tree", treePayload([
      { mode: "100644", name: "img.bin", oid: blobOid },
    ]));
    let commitOid = await impl.gitCache.putFromGatekeeper(
        999, "commit", commitPayload(treeOid, [], "binary fixture"));
    let { session, turn } = await createWorktreeSession(impl, 1, commitOid);

    await expect(session.readFile("img.bin")).rejects.toThrow("img.bin is not a text file");
    await session.writeFile("img.bin", "now text\n");
    let [, change] = Object.values(turn.bufferedChanges.at(-1)!.change)[0][0];
    expect(change).toEqual({ set: "now text\n" });
    expect(await session.readFile("img.bin")).toBe("now text\n");
  }));

  it("rejects writes and deletes over symlink, submodule, and directory entries",
      () => withImpl(async impl => {
    addChat(impl, 1);
    await loadFixtureRepo(impl);
    let { session } = await createWorktreeSession(impl, 1, COMMIT_1);

    await expect(session.writeFile("link.md", "x\n")).rejects.toThrow(
        "link.md is a symlink to README.md");
    await expect(session.writeFile("vendored", "x\n")).rejects.toThrow(/submodule/);
    await expect(session.writeFile("src", "x\n")).rejects.toThrow("src is a directory");
    await expect(session.deleteFile("link.md")).rejects.toThrow(/symlink/);
    await expect(session.deleteFile("vendored")).rejects.toThrow(/submodule/);
    await expect(session.deleteFile("src")).rejects.toThrow("src is a directory");
    await expect(session.deleteFile("missing.txt")).rejects.toThrow(
        "missing.txt: no such file");
  }));
});

describe("grep", () => {
  it("formats single-file and directory results like grep -n, skipping special entries",
      () => withImpl(async impl => {
    addChat(impl, 1);
    await loadFixtureRepo(impl);
    let { session } = await createWorktreeSession(impl, 1, COMMIT_1);

    expect(await session.grep(/answer/, "src/util.js")).toBe(
        "1:export const answer = 42;");
    expect(await session.grep(/answer/, "src")).toBe(
        "src/util.js:1:export const answer = 42;");
    expect(await session.grep(/answer/, "src/main.js")).toBe("(no matches)");

    // Omitting the path searches the whole tree, skipping the symlink and submodule entries
    // with notes.
    let root = await session.grep(/answer/);
    expect(root).toContain("src/util.js:1:export const answer = 42;");
    expect(root).toContain("(skipped: link.md is a symlink)");
    expect(root).toContain("(skipped: vendored is a submodule)");

    // Overlay content is searched (and overrides the base).
    await session.writeFile("src/util.js", "export const answer = 43;\n");
    expect(await session.grep(/answer = 43/, "src")).toBe(
        "src/util.js:1:export const answer = 43;");

    // A lone listed path that is unsearchable -- or doesn't exist -- throws rather than noting.
    await expect(session.grep(/x/, "link.md")).rejects.toThrow(/symlink/);
    await expect(session.grep(/x/, "no/such/path")).rejects.toThrow(
        "no/such/path: no such file or directory");
  }));

  it("searches an array of paths, degrading listed failures to skips unless all fail",
      () => withImpl(async impl => {
    addChat(impl, 1);
    await loadFixtureRepo(impl);
    let { session } = await createWorktreeSession(impl, 1, COMMIT_1);

    // A mixed list of directories and files, with overlapping entries deduplicated.
    expect(await session.grep(/answer|hello/, ["src", "src/util.js", "README.md"])).toBe(
        'src/main.js:1:console.log("hello");\n' +
        "src/util.js:1:export const answer = 42;");

    // An empty array searches nothing (and fails nothing).
    expect(await session.grep(/answer/, [])).toBe("(no matches)");
    expect(await session.structuredGrep(/answer/, [])).toEqual({ matches: [], errors: [] });

    // A failing listed path degrades to a skip when another listed path succeeds...
    expect(await session.grep(/answer/, ["src", "link.md", "missing.txt"])).toBe(
        "src/util.js:1:export const answer = 42;\n" +
        "(skipped: link.md is a symlink)\n" +
        "(skipped: missing.txt: no such file or directory)");

    // ...whereas every listed path failing throws, naming each failure.
    await expect(session.grep(/x/, ["link.md", "missing.txt"])).rejects.toThrow(
        "link.md is a symlink; missing.txt: no such file or directory");
  }));

  it("returns structured matches and errors", () => withImpl(async impl => {
    addChat(impl, 1);
    await loadFixtureRepo(impl);
    let { session } = await createWorktreeSession(impl, 1, COMMIT_1);
    expect(await session.structuredGrep(/answer/, "src")).toEqual({
      matches: [{ file: "src/util.js", line: 1, text: "export const answer = 42;" }],
      errors: [],
    });
    // The whole-tree search reports the files grep() would render as skip notes.
    expect(await session.structuredGrep(/answer/)).toEqual({
      matches: [{ file: "src/util.js", line: 1, text: "export const answer = 42;" }],
      errors: [
        { file: "link.md", error: "link.md is a symlink" },
        { file: "vendored", error: "vendored is a submodule" },
      ],
    });
  }));

  it("fills a directory's missing blobs in one batched pull", async () => {
    // Outside the DO: a WorkspaceGitCache with a mock pull source, so the pull count is
    // observable. The commit and trees are local (trees are eager); every blob is missing.
    let pulls: { oids: GitOid[], hints: GitPullHints }[] = [];
    let harness = makeLocalHarness(async (cache, oids, hints) => {
      pulls.push({ oids, hints });
      for (let oid of oids) {
        let object = FIXTURE_OBJECTS.find(o => o.oid === oid)!;
        await cache.putFromGatekeeper(7, object.type, b64Bytes(object.payload));
      }
    });
    for (let object of FIXTURE_OBJECTS) {
      if (PACKED_OIDS.includes(object.oid) &&
          (object.type === "commit" || object.type === "tree")) {
        await harness.cache.putFromGatekeeper(7, object.type, b64Bytes(object.payload));
      }
    }
    let session = harness.session(COMMIT_1);

    expect(await session.grep(/answer/, "src")).toBe(
        "src/util.js:1:export const answer = 42;");
    // All three of src's blobs arrived in a single batched pull -- never a per-file fetch.
    expect(pulls.length).toBe(1);
    expect(pulls[0].oids.toSorted()).toEqual([
      "30a8d2c2a21f0654d4a91f98a91989426b4f3343",  // src/big.txt @ commit 1
      "64a32fd291e405a963aacf964a021809dd206c46",  // src/util.js @ commit 1
      "702f4280cee76a8b022e896aedf2bad15b43726f",  // src/main.js
    ].toSorted());
    expect(pulls[0].hints.type).toBe("blob");

    // An array of scopes likewise fills all of its missing blobs in one pull -- the reason the
    // path argument accepts a list.
    expect(await session.grep(/Fixture|run/, ["README.md", "run.sh"])).toBe(
        "README.md:1:# Fixture\n" +
        "run.sh:2:echo run");
    expect(pulls.length).toBe(2);
    expect(pulls[1].oids.toSorted()).toEqual([
      "85ba14df52f8c72688537de6e7555fb402217b1e",  // run.sh
      "ca69e6d08b5b8bb4f11a74f9695e329c203cbfd8",  // README.md @ commit 1
    ].toSorted());
  });

  it("notes every path sharing one unobtainable oversized blob", async () => {
    // Two paths with identical content share a single blob oid. The pull "succeeds" but
    // delivers nothing, which the batched fetch's size filter reads as omitted-for-size: the
    // skip must then report *each* file holding that blob, not just one of them.
    let harness = makeLocalHarness(async () => {});
    let cache = harness.cache;
    let smallBlob = await cache.putFromGatekeeper(
        7, "blob", new TextEncoder().encode("x marks the spot\n"));
    let sharedOid = "cd".repeat(20);
    let treeOid = await cache.putFromGatekeeper(7, "tree", treePayload([
      { mode: "100644", name: "big1.txt", oid: sharedOid },
      { mode: "100644", name: "big2.txt", oid: sharedOid },
      { mode: "100644", name: "small.txt", oid: smallBlob },
    ]));
    let commitOid = await cache.putFromGatekeeper(
        7, "commit", commitPayload(treeOid, [], "shared blob fixture"));
    let session = harness.session(commitOid);

    let result = await session.grep(/x/);
    expect(result).toContain("small.txt:1:x marks the spot");
    expect(result).toContain("(skipped: big1.txt is too large to read)");
    expect(result).toContain("(skipped: big2.txt is too large to read)");

    // structuredGrep reports the same skips as error entries.
    expect(await session.structuredGrep(/x/)).toEqual({
      matches: [{ file: "small.txt", line: 1, text: "x marks the spot" }],
      errors: [
        { file: "big1.txt", error: "big1.txt is too large to read" },
        { file: "big2.txt", error: "big2.txt is too large to read" },
      ],
    });

    // A directly named file whose *content* is unreadable fails its scope: alone it throws,
    // beside a searchable path it degrades to a skip.
    await expect(session.grep(/x/, "big1.txt")).rejects.toThrow(
        "big1.txt is too large to read");
    expect(await session.grep(/x/, ["big1.txt", "small.txt"])).toBe(
        "small.txt:1:x marks the spot\n" +
        "(skipped: big1.txt is too large to read)");
  });
});

describe("commit and diff", () => {
  it("commit() parents on the head, buffers the advancement, and lands it at the barrier",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\ntwo\n" });
    let { id, session, turn } = await createWorktreeSession(impl, 1, c1);

    await session.writeFile("a.txt", "one!\ntwo\n");
    let commit = await session.commit("tweak a.txt");

    // Eager objects, in-memory head: the record advances only at the barrier (a crash -- or an
    // abort -- before it leaves the head unchanged and the commit dangling harmlessly).
    expect(impl.gitCache.hasLocalObject(commit)).toBe(true);
    expect(impl.storage.gadgets.get(id)!.headCommit).toBe(c1);
    expect(await session.diff()).toBe("");  // HEAD now reads as the buffered commit

    // Identity is the turn's initiator; the parent is the previous head; the tree is the
    // overlay over the pin base.
    let [info] = await impl.gitStore.readCommitLog(commit, { depth: 1 });
    expect(info.parents).toEqual([c1]);
    expect(info.author).toEqual({ name: "Alice", email: "alice@example.com" });
    expect(info.message).toBe("tweak a.txt\n");
    expect(await impl.readFileAtCommit(commit, "a.txt")).toBe("one!\ntwo\n");

    await turn.barrier();
    expect(impl.storage.gadgets.get(id)!.headCommit).toBe(commit);
  }));

  it("explicit commits squash out accepts' auto-commits", () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id, session, turn } = await createWorktreeSession(impl, 1, c1);

    // First explicit commit, landed at the barrier.
    await session.writeFile("a.txt", "two\n");
    let first = await session.commit("first");
    await turn.barrier();

    // An accept auto-commits the (clean-after-commit... make it dirty first) overlay and
    // re-pins. Note the pin advanced through an auto-commit while the head stayed `first`.
    await session.writeFile("a.txt", "three\n");
    await turn.barrier();
    await impl.mergeChanges(1, USER_META, "client-user");
    let record = impl.storage.gadgets.get(id)!;
    expect(record.headCommit).toBe(first);
    expect(record.pinBase).not.toBe(first);

    // A new turn (fresh overlay over the re-pin): the next explicit commit's parent is the
    // last explicit commit -- the auto-commit never appears in explicit history.
    let turn2 = makeTurn(impl, 1);
    turn2.pins.set(id, record.pinBase);
    let session2 = turn2.session(id);
    await session2.writeFile("a.txt", "four\n");
    let second = await session2.commit("second");
    let [info] = await impl.gitStore.readCommitLog(second, { depth: 1 });
    expect(info.parents).toEqual([first]);
    expect(await impl.readFileAtCommit(second, "a.txt")).toBe("four\n");
    await turn2.barrier();
    expect(impl.storage.gadgets.get(id)!.headCommit).toBe(second);
  }));

  it("an edited executable keeps its mode; untouched special entries ride through",
      () => withImpl(async impl => {
    addChat(impl, 1);
    await loadFixtureRepo(impl);
    let { session } = await createWorktreeSession(impl, 1, COMMIT_1);

    await session.writeFile("run.sh", "#!/bin/sh\necho run2\n");
    let commit = await session.commit("edit the script");
    expect((await impl.gitCache.pathEntryAtCommit(commit, "run.sh"))!.kind)
        .toBe("executable");
    expect((await impl.gitCache.pathEntryAtCommit(commit, "link.md"))!.kind).toBe("symlink");
    expect((await impl.gitCache.pathEntryAtCommit(commit, "vendored"))!.kind)
        .toBe("submodule");
    // New files default to regular non-executable.
    await session.writeFile("plain.txt", "text\n");
    let commit2 = await session.commit("add a file");
    expect((await impl.gitCache.pathEntryAtCommit(commit2, "plain.txt"))!.kind).toBe("file");
  }));

  it("diff() renders unified diffs of the overlay against a commit", () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\ntwo\n", "b.txt": "bee\n" });
    let { session } = await createWorktreeSession(impl, 1, c1);

    await session.writeFile("a.txt", "one!\ntwo\n");
    await session.deleteFile("b.txt");
    await session.writeFile("c.txt", "sea\n");

    let diff = await session.diff();  // default: HEAD (= the base commit; no commits yet)
    expect(diff).toBe([
      formatUnifiedDiff("a.txt", "one\ntwo\n", "one!\ntwo\n", true, true),
      formatUnifiedDiff("b.txt", "bee\n", "", true, false),
      formatUnifiedDiff("c.txt", "", "sea\n", false, true),
    ].join("\n"));
    expect(diff).toContain("-one");
    expect(diff).toContain("+one!");

    // Against an explicit commit id (here the same base, spelled out).
    expect(await session.diff(c1)).toBe(diff);
    await expect(session.diff("feed".repeat(10))).rejects.toThrow(/not known/);
  }));

  it("diff() reports EOF-newline changes with git's no-newline markers", () => withImpl(async impl => {
    addChat(impl, 1);
    // The base file has no trailing newline; the overlay only adds one. This must be a real
    // diff -- git records it as a remove-plus-add with a `\ No newline at end of file` marker
    // -- not an empty result. (formatUnifiedDiff delegates to jsdiff, which emits the marker;
    // this pins that behavior, since a hand-rolled sibling implementation once lost it.)
    let c1 = await commitFiles(impl, { "a.txt": "one" });
    let { session } = await createWorktreeSession(impl, 1, c1);
    await session.writeFile("a.txt", "one\n");

    let diff = await session.diff();
    expect(diff).toBe(formatUnifiedDiff("a.txt", "one", "one\n", true, true));
    expect(diff).toContain("-one\n\\ No newline at end of file\n+one");
  }));

  it("diff() notes special entries instead of failing", () => withImpl(async impl => {
    addChat(impl, 1);
    await loadFixtureRepo(impl);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { session } = await createWorktreeSession(impl, 1, c1);

    // Diff against an unrelated commit whose tree holds symlinks and submodules: those paths
    // become notes, text paths diff normally.
    let diff = await session.diff(COMMIT_1);
    expect(diff).toContain("(cannot diff link.md: link.md is a symlink to README.md)");
    expect(diff).toContain(
        "(cannot diff vendored: vendored is a submodule (gitlink) pointing at commit " +
        "1111111111111111111111111111111111111111)");
    expect(diff).toContain("+one");   // a.txt added relative to COMMIT_1
    expect(diff).toContain("-# Fixture");  // README.md removed relative to COMMIT_1
  }));

  it("diff() notes only unrenderable content; operational read failures propagate", async () => {
    // Outside the DO, with a pull source that always fails: unreadable *content* (a binary
    // blob) still degrades to a note, but a blob that cannot be *obtained* fails the diff --
    // a silently incomplete diff would misreport the worktree's state.
    let pulls: { oids: GitOid[], hints: GitPullHints }[] = [];
    let harness = makeLocalHarness(async (_cache, oids, hints) => {
      pulls.push({ oids, hints });
      throw new Error("simulated pull outage");
    });
    let cache = harness.cache;
    let base = await harness.gitStore.writeFilesAsCommit(new Map([["a.txt", "one\n"]]), {
      parents: [],
      author: { name: "Alice", email: "alice@example.com" },
      message: "base",
      timestamp: new Date(1700000000_000),
    });
    let binaryBlob = await cache.putFromGatekeeper(7, "blob", new Uint8Array([0x00, 0x01]));
    let ghostOid = "ab".repeat(20);  // recorded in the tree, never obtainable

    let renderableTree = await cache.putFromGatekeeper(7, "tree", treePayload([
      { mode: "100644", name: "img.bin", oid: binaryBlob },
    ]));
    let renderableTarget = await cache.putFromGatekeeper(
        7, "commit", commitPayload(renderableTree, [], "binary target"));
    let session = harness.session(base);
    let diff = await session.diff(renderableTarget);
    expect(diff).toContain("(cannot diff img.bin: img.bin is not a text file)");
    expect(diff).toContain("+one");  // a.txt still diffs normally

    let ghostTree = await cache.putFromGatekeeper(7, "tree", treePayload([
      { mode: "100644", name: "ghost.txt", oid: ghostOid },
    ]));
    let ghostTarget = await cache.putFromGatekeeper(
        7, "commit", commitPayload(ghostTree, [], "ghost target"));
    await expect(session.diff(ghostTarget)).rejects.toThrow(/simulated pull outage/);
    // The blob read's pull hint names its containing tree, not the commit: blobs are
    // referenced by trees (the referencedBy hint contract).
    expect(pulls).toEqual(
        [{ oids: [ghostOid], hints: expect.objectContaining({ referencedBy: ghostTree }) }]);
  });
});

describe("worktree binding description", () => {
  it("describeBinding serves the agent-API section of worktree-binding.d.ts",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let created = await impl.createWorktree("Repo", 1, c1);

    let description = await impl.describeBinding("REPO", created.id);
    expect(description).toContain(`rooted at git commit ${c1}`);
    expect(description).toContain("export interface Worktree");
    expect(description).toContain("structuredGrep");
    // Only the agent-facing section ships; the file header (and marker) stay out.
    expect(description).not.toContain("BEGIN AGENT API");
  }));

  it("worktree-binding.txt resolves to worktree-binding.d.ts", () => {
    // The .txt is a symlink to the .d.ts (same-directory: the validate build only
    // materializes files whose real location is inside the package), so identity is
    // structural; this guards the link itself and the text-module pipeline that ships it.
    expect(WORKTREE_BINDING_TYPES).toBe(WORKTREE_DTS_SOURCE);
  });
});

// ---------------------------------------------------------------------------
// Raw git object encoding helpers for hand-built fixtures (mirrors git-cache.test.ts).

function commitPayload(tree: GitOid, parents: GitOid[], message: string): Uint8Array {
  let text = [
    `tree ${tree}`,
    ...parents.map(parent => `parent ${parent}`),
    "author Test <test@example.com> 1700000000 +0000",
    "committer Test <test@example.com> 1700000000 +0000",
    "",
    `${message}\n`,
  ].join("\n");
  return new TextEncoder().encode(text);
}

function treePayload(entries: { mode: string, name: string, oid: GitOid }[]): Uint8Array {
  return concatBytes(entries.flatMap(entry => [
    new TextEncoder().encode(`${entry.mode} ${entry.name}\0`),
    Uint8Array.from(entry.oid.match(/../g)!.map(h => parseInt(h, 16))),
  ]));
}
