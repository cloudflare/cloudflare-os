import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { applyCodeChange, requireTextContent, type CodeChange, type CodeContent, type FileContent }
  from "@gadgets/workshop-shared/code-change";
import type { GitOid, GitPullHints } from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "../src/overseer.js";
import { WorktreeSessionImpl, type WorktreeSessionHost } from "../src/worktree-session";
import type { WorktreeTurnAccess } from "../src/agent";
import { formatUnifiedDiff } from "../src/agent";
import { WorkspaceGitCache } from "../src/git-cache";
import { makeOverseerStorage } from "../src/storage-schema/overseer-storage";
import { concatBytes, gitObjectOid } from "../src/git-codec";
import { CHUNK_MAX_SIZE } from "../src/git-chunked-blob";
import { makeMockStorage } from "./mock-storage";
import { COMMIT_1, FIXTURE_OBJECTS, PACKED_OIDS, b64Bytes } from "./git-cache-fixtures";
// Vite's ?raw import; resolved relative to this file, so the test below can compare the
// shipped text module against its source of truth.
// @ts-expect-error -- ?raw imports have no type declaration
import WORKTREE_DTS_SOURCE from "../src/worktree-binding.d.ts?raw";
// The text module workshop-backend ships -- a symlink to the .d.ts above (see
// agentApiText in overseer.ts).
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
// WorktreeSessionImpl end to end -- a session-content overlay with removal tombstones, the
// pinned-else-accepted base resolution, an appendChange that applies each change the way the
// step buffer does (pinning the worktree in the turn on its first write or commit, as the
// barrier will in the chat), and buffered commit advancements, all drained through the real
// barrier (impl.commitAgentStep).
function makeTurn(impl: any, chatId: number) {
  let content = new Map<number, Map<string, FileContent>>();
  let removed = new Map<number, Set<string>>();
  let pins = new Map<number, string>();
  let changes: { change: CodeChange }[] = [];
  let commits: { worktreeId: number, commit: string, previousHead: string }[] = [];
  let baseCommit = (id: number): string | undefined =>
      pins.get(id) ?? impl.getWorktreePinBase(id);
  let pin = (id: number) => {
    if (!pins.has(id)) pins.set(id, impl.getWorktreePinBase(id));
  };

  let access: WorktreeTurnAccess = {
    getBaseCommit: baseCommit,
    getBufferedHead: id => commits.findLast(entry => entry.worktreeId === id)?.commit,
    getOverlayFiles: id => content.get(id) ?? new Map(),
    getRemovedPaths: id => removed.get(id) ?? new Set(),
    readFile: async (id, path) => {
      let existing = content.get(id)?.get(path);
      if (existing !== undefined) return requireTextContent(existing);
      if (removed.get(id)?.has(path)) return undefined;
      let base = baseCommit(id);
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
      pin(id);
    },
    appendCommit: (id, commit, previousHead) => {
      commits.push({ worktreeId: id, commit, previousHead });
      pin(id);
    },
  };

  return {
    access,
    pins,
    bufferedChanges: changes,
    bufferedCommits: commits,
    session: (id: number) => new WorktreeSessionImpl(impl, id, access, async () => USER),
    barrier: async () => impl.commitAgentStep(
        chatId, AGENT, [{ type: "message", message: "step" }],
        { changes: changes.splice(0), createdGadgets: [], createdWorktrees: [],
          addedBindings: [], worktreeCommits: commits.splice(0) }),
  };
}

// Creates a worktree through the barrier and returns a session over it. The worktree is
// unpinned: the session resolves against its accepted commit until the first write or commit.
async function createWorktreeSession(impl: any, chatId: number, commitId: string) {
  let created = await impl.createWorktree("Repo", chatId, commitId);
  await impl.commitAgentStep(chatId, AGENT, [{ type: "message", message: "create" }], {
    changes: [],
    createdGadgets: [],
    createdWorktrees: [{ worktreeId: created.id, title: created.title, bindingName: "REPO" }],
    addedBindings: [],
    worktreeCommits: [],
  });
  let turn = makeTurn(impl, chatId);
  return { id: created.id, baseCommit: created.baseCommit, turn,
           session: turn.session(created.id) };
}

async function commitFiles(
    impl: any, files: Record<string, string>, parents: string[] = []): Promise<string> {
  return await impl.gitCache.writeFilesAsCommit(new Map(Object.entries(files)), {
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
  let storage = makeOverseerStorage(makeMockStorage());
  let cache: WorkspaceGitCache = new WorkspaceGitCache(storage, {
    pull: (_gatekeeperId, oids, hints) => pull(cache, oids, hints),
  });
  let session = (pinBase: string): WorktreeSessionImpl => {
    let host: WorktreeSessionHost = {
      gitCache: cache,
      getWorktreeRecord: () => ({ headCommit: pinBase }),
    };
    let access: WorktreeTurnAccess = {
      getBaseCommit: () => pinBase,
      getBufferedHead: () => undefined,
      getOverlayFiles: () => new Map(),
      getRemovedPaths: () => new Set(),
      readFile: async (_id, path) => cache.readFileAtCommitIfExists(pinBase, path),
      appendChange: () => { throw new Error("read-only test"); },
      appendCommit: () => { throw new Error("read-only test"); },
    };
    return new WorktreeSessionImpl(host, 5, access, async () => USER);
  };
  return { cache, session };
}

// Deterministic bytes with no long repeats, so chunking finds content-defined cuts.
const pseudoRandom = (size: number, seed: number) => {
  let out = new Uint8Array(size);
  for (let i = 0, x = seed; i < size; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
};
const read = async (stream: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(stream).arrayBuffer());
// Large arrays compare by Buffer, not by vitest's element-wise deep equality.
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

describe("streamed bytes", () => {
  it("reads a range from the middle of a chunked blob, exactly, a piece at a time",
      () => withImpl(async impl => {
    addChat(impl, 1);
    const {session} = await createWorktreeSession(impl, 1, await commitFiles(impl, {}));
    const data = pseudoRandom(5 * CHUNK_MAX_SIZE, 1);
    await session.writeBytes("big.bin", data);
    const range = {offset: 1_234_567, length: 2 * CHUNK_MAX_SIZE + 89};
    expect(same(await read(await session.readBytes("big.bin", range)),
                data.subarray(range.offset, range.offset + range.length))).toBe(true);
    expect(same(await read(await session.readBytes("big.bin")), data)).toBe(true);
    await expect(session.readBytes("big.bin", {offset: data.length - 1, length: 2}))
      .rejects.toThrow("Invalid byte range");
  }));

  it("stops a blob's stream when the session ends mid-read", () => withImpl(async impl => {
    addChat(impl, 1);
    const {session, turn} = await createWorktreeSession(impl, 1, await commitFiles(impl, {}));
    await session.writeBytes("big.bin", pseudoRandom(4 * CHUNK_MAX_SIZE, 2));
    const reader = (await session.readBytes("big.bin")).getReader();
    expect((await reader.read()).done).toBe(false);
    const live = turn.access.getBaseCommit;
    turn.access.getBaseCommit = () => undefined;
    try {
      // At most the piece being delivered is still read; the stream then errors.
      let error: unknown;
      let after = 0;
      for (;;) {
        try {
          let result = await reader.read();
          if (result.done) break;
          after += result.value.byteLength;
        } catch (err) {
          error = err;
          break;
        }
      }
      expect(after).toBeLessThanOrEqual(CHUNK_MAX_SIZE);
      expect(String(error)).toContain("not part of the current session");
    } finally {
      turn.access.getBaseCommit = live;
    }
  }));

  it.each(["default", "bytes"] as const)(
      "writes a %s stream of odd-sized pieces, of any length, as one blob", type => withImpl(async impl => {
    addChat(impl, 1);
    const {session, turn} = await createWorktreeSession(impl, 1, await commitFiles(impl, {}));
    const data = pseudoRandom(type === "default" ? 30_000_000 : 3 * CHUNK_MAX_SIZE + 5, 3);
    const piece = 777_777;
    let pos = 0;
    const stream = new ReadableStream<Uint8Array>({
      ...(type === "bytes" ? {type: "bytes" as const} : {}),
      pull(controller) {
        if (pos >= data.length) {
          controller.close();
          (controller as ReadableByteStreamController).byobRequest?.respond(0);
          return;
        }
        controller.enqueue(data.slice(pos, pos += piece));
      },
    });
    await session.writeBytes("stream.bin", stream);
    const commit = await session.commit("streamed");
    await turn.barrier();
    const ref = await impl.gitCache.fileBytesAtCommit(commit, "stream.bin");
    expect(ref).toEqual({oid: await gitObjectOid("blob", data), byteLength: data.length});
    expect(same(impl.gitCache.readBlob(ref.oid, ref.byteLength), data)).toBe(true);
  }), 60_000);
});

describe("listFiles", () => {
  it("keeps raw reads observational and preserves text reads, edits and commits", () => withImpl(async impl => {
    addChat(impl, 1);
    const text = "\ufeffhello😀\n";
    const base = await commitFiles(impl, {"a.txt": text});
    const {session, turn, id} = await createWorktreeSession(impl, 1, base);
    expect(await new Response(await session.readBytes("a.txt")).bytes()).toEqual(new TextEncoder().encode(text));
    expect(turn.access.getOverlayFiles(id).has("a.txt")).toBe(false);
    expect(await session.readFile("a.txt")).toBe(text);
    expect(impl.gitCache.readCommitFiles(base)).toEqual(new Map([["a.txt", text]]));
    await session.writeFile("a.txt", text + "edited\n");
    const commit = await session.commit("text after raw read");
    await turn.barrier();
    expect(impl.gitCache.readCommitFiles(commit)).toEqual(new Map([["a.txt", text + "edited\n"]]));
  }));

  it("resolves byte identities without copying the Git object or adding permission records", () => withImpl(async impl => {
    const commit = await commitFiles(impl, {"a.txt": "same text\n"});
    const before = [...impl.storage.gitObjects.list()];
    const [a, b] = await Promise.all([
      impl.gitCache.fileBytesAtCommit(commit, "a.txt"),
      impl.gitCache.fileBytesAtCommit(commit, "a.txt"),
    ]);
    expect(a).toEqual(b);
    addChat(impl, 1);
    const {session} = await createWorktreeSession(impl, 1, commit);
    expect(await new Response(await session.readBytes("a.txt")).text()).toBe("same text\n");
    expect([...impl.storage.gitObjects.list()]).toEqual(before);
    expect(impl.gitCache.readCommitFiles(commit)).toEqual(new Map([["a.txt", "same text\n"]]));
  }));

  it("bounds byte writes and ranges without changing the file on failure", () => withImpl(async impl => {
    addChat(impl, 1);
    const base = await commitFiles(impl, {});
    const {session} = await createWorktreeSession(impl, 1, base);
    await session.writeBytes("data.bin", Uint8Array.of(0, 255, 7));
    expect(await new Response(await session.readBytes("data.bin", {offset: 1, length: 2})).bytes())
      .toEqual(Uint8Array.of(255, 7));
    expect(await new Response(await session.readBytes("data.bin", {offset: 3, length: 0})).bytes())
      .toEqual(new Uint8Array());
    for (const range of [{offset: -1, length: 1}, {offset: 0, length: -1}, {offset: 1, length: 3},
      {offset: 4, length: 0}, {offset: 0.5, length: 1}, {offset: Number.MAX_SAFE_INTEGER, length: 1}]) {
      await expect(session.readBytes("data.bin", range)).rejects.toThrow("Invalid byte range");
    }
    // Bytes of any size can be written and read back.
    const large = new Uint8Array(9 * 1024 * 1024);
    for (let i = 0; i < large.length; i += 4093) large[i] = i & 0xff;
    await session.writeBytes("large.bin", large);
    expect(await new Response(await session.readBytes("large.bin", {offset: 4093 * 1000, length: 3}))
      .bytes()).toEqual(large.slice(4093 * 1000, 4093 * 1000 + 3));
    expect(await new Response(await session.readBytes("data.bin")).bytes()).toEqual(Uint8Array.of(0, 255, 7));
    await session.writeBytes("empty.bin", new Uint8Array());
    expect(await new Response(await session.readBytes("empty.bin")).bytes()).toEqual(new Uint8Array());
    await expect(session.readBytes("missing.bin")).rejects.toThrow("no such file");
  }));

  it("writes, replaces, commits and deletes bytes through the DO worktree API", () => withImpl(async impl => {
    addChat(impl, 1);
    const base = await commitFiles(impl, {});
    const {session, turn, id} = await createWorktreeSession(impl, 1, base);
    await session.writeBytes("image.bin", Uint8Array.of(0, 255, 3, 4));
    await session.writeBytes("image.bin", Uint8Array.of(0, 5, 0, 3, 4));
    expect(new Uint8Array(await new Response(await session.readBytes("image.bin")).arrayBuffer())).toEqual(Uint8Array.of(0, 5, 0, 3, 4));
    const commit = await session.commit("binary replacement");
    await turn.barrier();
    expect(impl.getWorktreeRecord(id).headCommit).toBe(commit);
    const value = await impl.gitCache.fileBytesAtCommit(commit, "image.bin");
    expect(impl.gitCache.readBlob(value.oid, value.byteLength)).toEqual(Uint8Array.of(0, 5, 0, 3, 4));
    await expect(session.readFile("image.bin")).rejects.toThrow(/Binary/);
    await session.deleteFile("image.bin");
    const deleted = await session.commit("delete binary");
    await turn.barrier();
    expect(await impl.gitCache.fileBytesAtCommit(deleted, "image.bin")).toBeUndefined();
  }));
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

  it("notes every path sharing one binary blob, and searches a large file", async () => {
    // Two paths with identical content share a single blob oid: the skip must report *each*
    // file holding that blob, not just one of them. A file of any size is searched.
    let harness = makeLocalHarness(async () => {});
    let cache = harness.cache;
    let smallBlob = await cache.putFromGatekeeper(
        7, "blob", new TextEncoder().encode("x marks the spot\n"));
    let sharedOid = await cache.putFromGatekeeper(7, "blob", new Uint8Array([0x78, 0, 0x78]));
    let hugeBlob = await cache.putFromGatekeeper(7, "blob",
        new TextEncoder().encode(`${"filler line\n".repeat(800_000)}x at the end\n`));
    let treeOid = await cache.putFromGatekeeper(7, "tree", treePayload([
      { mode: "100644", name: "big1.txt", oid: sharedOid },
      { mode: "100644", name: "big2.txt", oid: sharedOid },
      { mode: "100644", name: "huge.txt", oid: hugeBlob },
      { mode: "100644", name: "small.txt", oid: smallBlob },
    ]));
    let commitOid = await cache.putFromGatekeeper(
        7, "commit", commitPayload(treeOid, [], "shared blob fixture"));
    let session = harness.session(commitOid);

    let result = await session.grep(/x/);
    expect(result).toContain("small.txt:1:x marks the spot");
    expect(result).toContain("huge.txt:800001:x at the end");
    expect(result).toContain("(skipped: big1.txt is not a text file)");
    expect(result).toContain("(skipped: big2.txt is not a text file)");

    // structuredGrep reports the same skips as error entries.
    expect(await session.structuredGrep(/x/, ["big1.txt", "big2.txt", "small.txt"])).toEqual({
      matches: [{ file: "small.txt", line: 1, text: "x marks the spot" }],
      errors: [
        { file: "big1.txt", error: "big1.txt is not a text file" },
        { file: "big2.txt", error: "big2.txt is not a text file" },
      ],
    });

    // A directly named file whose *content* is unreadable fails its scope: alone it throws,
    // beside a searchable path it degrades to a skip.
    await expect(session.grep(/x/, "big1.txt")).rejects.toThrow(
        "big1.txt is not a text file");
    expect(await session.grep(/x/, ["big1.txt", "small.txt"])).toBe(
        "small.txt:1:x marks the spot\n" +
        "(skipped: big1.txt is not a text file)");
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
    let [info] = impl.gitCache.readCommitLog(commit, { depth: 1 });
    expect(info.parents).toEqual([c1]);
    expect(info.author).toEqual({ name: "Alice", email: "alice@example.com" });
    expect(info.message).toBe("tweak a.txt\n");
    expect(await impl.readFileAtCommit(commit, "a.txt")).toBe("one!\ntwo\n");

    await turn.barrier();
    expect(impl.storage.gadgets.get(id)!.headCommit).toBe(commit);
    // The write was the epoch's first modification: the barrier pinned the worktree at its
    // accepted commit, declared on the step's message alongside the advancement.
    expect(impl.storage.chatMeta.get(1)!.codeBase!.pins).toEqual(
        [{ gadgetId: id, baseCommit: c1, mergedCommit: c1 }]);
  }));

  it("commit() on an untouched worktree pins it, so the advancement is a revertable change",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { id, session, turn } = await createWorktreeSession(impl, 1, c1);
    expect(impl.storage.chatMeta.get(1)!.codeBase).toBeUndefined();

    // No writes: the commit's tree is the accepted commit's, parented on the head.
    let commit = await session.commit("empty");
    expect(impl.gitCache.commitTree(commit)).toBe(impl.gitCache.commitTree(c1));
    await turn.barrier();
    expect(impl.storage.gadgets.get(id)!.headCommit).toBe(commit);
    expect(impl.storage.chatMeta.get(1)!.codeBase!.pins).toEqual(
        [{ gadgetId: id, baseCommit: c1, mergedCommit: c1 }]);
    let step = [...impl.storage.chats.list()].at(-1)!;
    expect(step.pins).toEqual([{ gadgetId: id, baseCommit: c1 }]);
    expect(step.worktreeCommits).toEqual([{ worktreeId: id, commit, previousHead: c1 }]);

    // Reverting the step rolls the head back and unpins.
    await impl.revertChanges(1, step.sequence, USER);
    expect(impl.storage.gadgets.get(id)!.headCommit).toBe(c1);
    expect(impl.storage.chatMeta.get(1)!.codeBase!.pins).toEqual([]);
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
    // advances the accepted commit. Note it advanced through an auto-commit while the head
    // stayed `first`.
    await session.writeFile("a.txt", "three\n");
    await turn.barrier();
    await impl.mergeChanges(1, USER_META, "client-user");
    let record = impl.storage.gadgets.get(id)!;
    expect(record.headCommit).toBe(first);
    expect(record.pinBase).not.toBe(first);

    // A new turn (fresh overlay over the unpinned worktree, which resolves against the
    // advanced accepted commit): the next explicit commit's parent is the last explicit commit
    // -- the auto-commit never appears in explicit history.
    let turn2 = makeTurn(impl, 1);
    let session2 = turn2.session(id);
    expect(await session2.readFile("a.txt")).toBe("three\n");
    await session2.writeFile("a.txt", "four\n");
    let second = await session2.commit("second");
    let [info] = impl.gitCache.readCommitLog(second, { depth: 1 });
    expect(info.parents).toEqual([first]);
    expect(await impl.readFileAtCommit(second, "a.txt")).toBe("four\n");
    await turn2.barrier();
    expect(impl.storage.gadgets.get(id)!.headCommit).toBe(second);
    // ...and the write re-pinned the worktree at the advanced accepted commit.
    expect(impl.storage.chatMeta.get(1)!.codeBase!.pins).toEqual(
        [{ gadgetId: id, baseCommit: record.pinBase, mergedCommit: record.pinBase }]);
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
    // Only full ids: knowing one is the capability to read the commit, and a prefix is guessable.
    await expect(session.diff(c1.slice(0, 8))).rejects.toThrow(/not a full git commit id/);
  }));

  it("diff() diffs a 9 MB file's change as text", () => withImpl(async impl => {
    addChat(impl, 1);
    let big = Array.from({ length: 600_000 }, (_, i) => `line ${i} of the file`).join("\n") + "\n";
    expect(big.length).toBeGreaterThan(9_000_000);
    let c1 = await commitFiles(impl, { "big.txt": big });
    let { session } = await createWorktreeSession(impl, 1, c1);
    await session.writeFile("big.txt", big.replace("line 543210 of the file\n", "line 543210 changed\n"));
    let diff = await session.diff();
    expect(diff).toContain("-line 543210 of the file\n+line 543210 changed\n");
    expect(diff.length).toBeLessThan(1000);
    let structured = await session.structuredDiff();
    expect(structured.errors).toEqual([]);
    expect(structured.files.map(file => [file.path, file.status])).toEqual([["big.txt", "modified"]]);
  }), 60_000);

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
    let base = await harness.cache.writeFilesAsCommit(new Map([["a.txt", "one\n"]]), {
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

  it("structuredDiff() returns numbered hunks per changed file", () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, {
      "a.txt": "one\ntwo\n",
      "b.txt": "bee\n",
      "long.txt": "1\n2\n3\n4\n5\n6\n7\n8\n",
      "same.txt": "unchanged\n",
    });
    let { session } = await createWorktreeSession(impl, 1, c1);

    await session.writeFile("a.txt", "one!\ntwo\n");
    await session.deleteFile("b.txt");
    await session.writeFile("c.txt", "sea\n");
    await session.writeFile("empty.txt", "");
    await session.writeFile("long.txt", "1\n2\n3\n4\n4.5\n5\n6\n7\n8\n");

    let result = await session.structuredDiff();
    expect(result).toEqual({
      files: [
        { path: "a.txt", status: "modified", oldKind: "file", newKind: "file",
          hunks: [{ header: "@@ -1,2 +1,2 @@", lines: [
          { kind: "removed", text: "one", oldLineNumber: 1 },
          { kind: "added", text: "one!", newLineNumber: 1 },
          { kind: "context", text: "two", oldLineNumber: 2, newLineNumber: 2 },
        ] }] },
        { path: "b.txt", status: "removed", oldKind: "file",
          hunks: [{ header: "@@ -1,1 +0,0 @@", lines: [
          { kind: "removed", text: "bee", oldLineNumber: 1 },
        ] }] },
        { path: "c.txt", status: "added", newKind: "file",
          hunks: [{ header: "@@ -0,0 +1,1 @@", lines: [
          { kind: "added", text: "sea", newLineNumber: 1 },
        ] }] },
        // An empty file has no lines to diff, but its addition still shows.
        { path: "empty.txt", status: "added", newKind: "file", hunks: [] },
        // Context is limited to 3 lines, so the hunk starts mid-file.
        { path: "long.txt", status: "modified", oldKind: "file", newKind: "file",
          hunks: [{ header: "@@ -2,6 +2,7 @@", lines: [
          { kind: "context", text: "2", oldLineNumber: 2, newLineNumber: 2 },
          { kind: "context", text: "3", oldLineNumber: 3, newLineNumber: 3 },
          { kind: "context", text: "4", oldLineNumber: 4, newLineNumber: 4 },
          { kind: "added", text: "4.5", newLineNumber: 5 },
          { kind: "context", text: "5", oldLineNumber: 5, newLineNumber: 6 },
          { kind: "context", text: "6", oldLineNumber: 6, newLineNumber: 7 },
          { kind: "context", text: "7", oldLineNumber: 7, newLineNumber: 8 },
        ] }] },
      ],
      errors: [],
    });

    // Headers are spelled exactly as the rendered diff spells them.
    let diffLines = (await session.diff()).split("\n");
    for (let file of result.files) {
      for (let hunk of file.hunks) expect(diffLines).toContain(hunk.header);
    }

    // Against an explicit commit id, with the same id rules as diff().
    expect(await session.structuredDiff(c1)).toEqual(result);
    await expect(session.structuredDiff(c1.slice(0, 8))).rejects.toThrow(/not a full git commit id/);

    // After committing, HEAD matches the worktree.
    await session.commit("changes");
    expect(await session.structuredDiff()).toEqual({ files: [], errors: [] });
  }));

  it("structuredDiff() reports EOF-newline markers as unnumbered context",
      () => withImpl(async impl => {
    addChat(impl, 1);
    let c1 = await commitFiles(impl, { "a.txt": "one" });
    let { session } = await createWorktreeSession(impl, 1, c1);
    await session.writeFile("a.txt", "one\n");

    expect(await session.structuredDiff()).toEqual({
      files: [{ path: "a.txt", status: "modified", oldKind: "file", newKind: "file",
                hunks: [{ header: "@@ -1,1 +1,1 @@", lines: [
        { kind: "removed", text: "one", oldLineNumber: 1 },
        { kind: "context", text: "\\ No newline at end of file" },
        { kind: "added", text: "one", newLineNumber: 1 },
      ] }] }],
      errors: [],
    });
  }));

  it("structuredDiff() reports special entries as errors", () => withImpl(async impl => {
    addChat(impl, 1);
    await loadFixtureRepo(impl);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let { session } = await createWorktreeSession(impl, 1, c1);

    let result = await session.structuredDiff(COMMIT_1);
    expect(result.errors).toEqual(expect.arrayContaining([
      { file: "link.md", error: "link.md is a symlink to README.md" },
      { file: "vendored", error: "vendored is a submodule (gitlink) pointing at commit " +
                                 "1111111111111111111111111111111111111111" },
    ]));
    expect(result.files).toContainEqual({ path: "a.txt", status: "added", newKind: "file", hunks: [
      { header: "@@ -0,0 +1,1 @@", lines: [{ kind: "added", text: "one", newLineNumber: 1 }] },
    ] });
    expect(result.files.find(file => file.path === "README.md")?.status).toBe("removed");
    // Every path lands in exactly one of the two lists.
    let errorPaths = result.errors.map(error => error.file);
    expect(result.files.some(file => errorPaths.includes(file.path))).toBe(false);
  }));

  it("diffs report executable-bit changes, with or without content changes",
      () => withImpl(async impl => {
    addChat(impl, 1);
    // Two commits holding the same blobs, differing only in the files' modes.
    let scriptOid = await impl.gitCache.putFromGatekeeper(
        999, "blob", new TextEncoder().encode("#!/bin/sh\n"));
    let toolOid = await impl.gitCache.putFromGatekeeper(
        999, "blob", new TextEncoder().encode("tool\n"));
    let commitWithModes = async (entries: { mode: string, name: string, oid: string }[]) => {
      let tree = await impl.gitCache.putFromGatekeeper(999, "tree", treePayload(entries));
      return await impl.gitCache.putFromGatekeeper(
          999, "commit", commitPayload(tree, [], JSON.stringify(entries)));
    };
    let plain = await commitWithModes([
      { mode: "100644", name: "script.sh", oid: scriptOid },
      { mode: "100755", name: "tool", oid: toolOid },
    ]);
    let modesFlipped = await commitWithModes([
      { mode: "100755", name: "script.sh", oid: scriptOid },
      { mode: "100644", name: "tool", oid: toolOid },
    ]);
    let toolOnly = await commitWithModes([{ mode: "100644", name: "tool", oid: toolOid }]);
    let { session } = await createWorktreeSession(impl, 1, modesFlipped);
    // An edit keeps the base's mode, so this is a content change on top of the mode change.
    await session.writeFile("tool", "tool v2\n");
    let toolHunks = [{ header: "@@ -1,1 +1,1 @@", lines: [
      { kind: "removed", text: "tool", oldLineNumber: 1 },
      { kind: "added", text: "tool v2", newLineNumber: 1 },
    ] }];
    let toolDiff = formatUnifiedDiff("tool", "tool\n", "tool v2\n", true, true);

    // Mode changes: a "modified" file whose kinds differ, with or without hunks.
    expect(await session.structuredDiff(plain)).toEqual({
      files: [
        { path: "script.sh", status: "modified", oldKind: "file", newKind: "executable",
          hunks: [] },
        { path: "tool", status: "modified", oldKind: "executable", newKind: "file",
          hunks: toolHunks },
      ],
      errors: [],
    });
    expect(await session.diff(plain)).toBe([
      "diff --git a/script.sh b/script.sh\nold mode 100644\nnew mode 100755",
      "diff --git a/tool b/tool\nold mode 100755\nnew mode 100644",
      toolDiff,
    ].join("\n"));

    // An added executable names its kind; an unchanged mode gets no mode lines.
    let scriptHunks = [{ header: "@@ -0,0 +1,1 @@", lines: [
      { kind: "added", text: "#!/bin/sh", newLineNumber: 1 },
    ] }];
    expect((await session.structuredDiff(toolOnly)).files).toEqual([
      { path: "script.sh", status: "added", newKind: "executable", hunks: scriptHunks },
      { path: "tool", status: "modified", oldKind: "file", newKind: "file", hunks: toolHunks },
    ]);
    expect(await session.diff(toolOnly)).toBe([
      "diff --git a/script.sh b/script.sh\nnew file mode 100755",
      formatUnifiedDiff("script.sh", "", "#!/bin/sh\n", false, true),
      toolDiff,
    ].join("\n"));

    // So does a removed one.
    await session.deleteFile("script.sh");
    expect((await session.structuredDiff(modesFlipped)).files).toEqual([
      { path: "script.sh", status: "removed", oldKind: "executable", hunks: [
        { header: "@@ -1,1 +0,0 @@",
          lines: [{ kind: "removed", text: "#!/bin/sh", oldLineNumber: 1 }] },
      ] },
      { path: "tool", status: "modified", oldKind: "file", newKind: "file", hunks: toolHunks },
    ]);
    expect(await session.diff(modesFlipped)).toBe([
      "diff --git a/script.sh b/script.sh\ndeleted file mode 100755",
      formatUnifiedDiff("script.sh", "#!/bin/sh\n", "", true, false),
      toolDiff,
    ].join("\n"));
  }));
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
