import { describe, expect, it } from "vitest";
import { RpcStub, env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { GitImpl } from "../src/git-binding";
import type { GitPullHints } from "@gadgets/workshop-shared/gatekeeper";
import { COMMIT_1, COMMIT_2, FIXTURE_OBJECTS, PACKED_OIDS, TREE_1, b64Bytes }
  from "./git-cache-fixtures";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// Exercises the env.GIT binding (git-binding.ts): in-memory worktrees served by the same
// WorktreeSessionImpl as the agent's worktree bindings, whose only durable effect is commit
// objects -- plus its presence in every env, and the reserved name.

const OWNER = "owner@example.com";
const ALICE: AiChatAuthorInfo = { type: "user", id: "alice@example.com", name: "Alice" };

let doCounter = 0;
async function withImpl(
    fn: (impl: any) => Promise<void>,
    ownerProfile: AiChatAuthorInfo = { type: "user", id: OWNER, name: "Owner" }): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`git-binding-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = "owner-user-do";
    impl.users = {
      idFromString: (id: string) => id,
      idFromName: (name: string) => name,
      get: () => ({ whoami: async () => ownerProfile }),
    };
    impl.storage.title.put("My Workspace");
    await fn(impl);
  });
}

async function openGit(impl: any): Promise<GitImpl> {
  return await impl.startGatekeeperSession({ type: "git" }, { from: "gadget", gadgetId: 100 });
}

async function commitFiles(impl: any, files: Record<string, string>): Promise<string> {
  return await impl.gitStore.writeFilesAsCommit(new Map(Object.entries(files)), {
    parents: [],
    author: { name: "Alice", email: "alice@example.com" },
    message: "test commit",
    timestamp: new Date(1700000000_000),
  });
}

// Every stored object's oid, to observe that nothing but commit() writes.
function storedOids(impl: any): string[] {
  return [...impl.storage.gitObjects.list()].map((record: { oid: string }) => record.oid);
}

function seedGadget(impl: any, id: number, bindings: Record<string, unknown> = {}): void {
  impl.storage.gadgets.put(
      { type: "gadget", id, title: "G", created: new Date(0), bindingName: `G${id}`, bindings });
}

describe("env.GIT worktrees", () => {
  it("read a commit's tree", () => withImpl(async impl => {
    for (let object of FIXTURE_OBJECTS) {
      if (PACKED_OIDS.includes(object.oid)) {
        await impl.gitCache.putFromGatekeeper(999, object.type, b64Bytes(object.payload));
      }
    }
    let git = await openGit(impl);
    let worktree = await git.newWorktree(COMMIT_1);

    expect(await worktree.listFiles()).toContainEqual({ path: "run.sh", kind: "executable" });
    expect(await worktree.readFile("README.md")).toContain("# Fixture");
    expect(await worktree.grep(/Fixture/, "README.md")).toMatch(/^1:# Fixture/);
    expect(await worktree.diff()).toBe("");
  }));

  it("edits live in memory; commits persist and root later worktrees",
      () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n", "b.txt": "bee\n" });
    let git = await openGit(impl);
    let worktree = await git.newWorktree(c1);
    let before = storedOids(impl);

    await worktree.writeFile("a.txt", "one!\n");
    await worktree.deleteFile("b.txt");
    await worktree.writeFile("dir/c.txt", "sea\n");
    expect(await worktree.readFile("a.txt")).toBe("one!\n");
    await expect(worktree.readFile("b.txt")).rejects.toThrow(/no such file/);
    expect(await worktree.listFiles(undefined, { recursive: true })).toEqual([
      { path: "a.txt", kind: "file" },
      { path: "dir", kind: "dir" },
      { path: "dir/c.txt", kind: "file" },
    ]);
    expect(await worktree.diff()).toContain("+one!");
    // Nothing stored: no workpiece record, no git objects.
    expect(storedOids(impl)).toEqual(before);
    expect([...impl.storage.gadgets.list()]).toEqual([]);

    // A second worktree on the same commit sees none of it.
    let other = await git.newWorktree(c1);
    expect(await other.readFile("a.txt")).toBe("one\n");
    expect(await other.readFile("b.txt")).toBe("bee\n");

    let commit = await worktree.commit("first");
    let [info] = await impl.gitStore.readCommitLog(commit, { depth: 1 });
    expect(info.parents).toEqual([c1]);
    expect(info.message).toBe("first\n");
    // Gadget callers commit as a spawned agent would: the workspace, under the owner's id.
    expect(info.author).toEqual({ name: "My Workspace", email: OWNER });
    expect(await worktree.diff()).toBe("");
    expect(await worktree.diff(c1)).toContain("-bee");

    // The head advances, so the next commit parents on the last one.
    await worktree.writeFile("a.txt", "two\n");
    let second = await worktree.commit("second");
    expect((await impl.gitStore.readCommitLog(second, { depth: 1 }))[0].parents)
        .toEqual([commit]);

    // The commit id is the durable handle: a fresh worktree picks up where this one left off.
    let resumed = await (await openGit(impl)).newWorktree(second);
    expect(await resumed.readFile("a.txt")).toBe("two\n");
    expect(await resumed.readFile("dir/c.txt")).toBe("sea\n");
    await expect(resumed.readFile("b.txt")).rejects.toThrow(/no such file/);
  }));

  it("works through an RPC stub", () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    using git = new RpcStub(await openGit(impl));
    using worktree = await git.newWorktree(c1);
    await worktree.writeFile("a.txt", "two\n");
    let commit = await worktree.commit("over RPC");
    expect(await impl.readFileAtCommit(commit, "a.txt")).toBe("two\n");
    expect(await worktree.structuredGrep(/two/)).toEqual(
        { matches: [{ file: "a.txt", line: 1, text: "two" }], errors: [] });
    expect(await worktree.structuredDiff(c1)).toEqual({
      files: [{ path: "a.txt", status: "modified", oldKind: "file", newKind: "file",
                hunks: [{ header: "@@ -1,1 +1,1 @@", lines: [
        { kind: "removed", text: "one", oldLineNumber: 1 },
        { kind: "added", text: "two", newLineNumber: 1 },
      ] }] }],
      errors: [],
    });
  }));

  it("gives gadget commits the owner's commit email, looked up only at commit",
      () => withImpl(async impl => {
    let lookups = 0;
    let owner = impl.users.get();
    impl.users.get = () => ({ whoami: () => { ++lookups; return owner.whoami(); } });

    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let worktree = await (await openGit(impl)).newWorktree(c1);
    await worktree.writeFile("a.txt", "two\n");
    expect(await worktree.readFile("a.txt")).toBe("two\n");
    expect(lookups).toBe(0);

    let commit = await worktree.commit("gadget commit");
    expect(lookups).toBe(1);
    expect((await impl.gitStore.readCommitLog(commit, { depth: 1 }))[0].author)
        .toEqual({ name: "My Workspace", email: "owner@commits.example" });
  }, { type: "user", id: OWNER, name: "Owner", commitEmail: "owner@commits.example" }));

  it("attributes the agent's commits to its turn's initiator", () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let commitAs = async (caller: unknown) => {
      let git: GitImpl = await impl.startGatekeeperSession({ type: "git" }, caller);
      let worktree = await git.newWorktree(c1);
      let commit = await worktree.commit("agent commit");
      return (await impl.gitStore.readCommitLog(commit, { depth: 1 }))[0].author;
    };

    // Opened while an executeCode run is in progress: the identity the chat's own worktree
    // commits carry. (The run is only held open here -- its env loopbacks aren't reachable from
    // this test pool -- which registers the turn for its duration.)
    let turn = new Proxy({}, { get: () => () => { throw new Error("unused"); } });
    let running = impl.executeCodeMode(1, `
        export default async function() { await new Promise(r => setTimeout(r, 1000)); }`,
        ALICE, "some-model", {}, undefined, turn);
    expect(await commitAs({ from: "agent", chatId: 1 }))
        .toEqual({ name: "Alice", email: "alice@example.com" });
    await running;

    // With no run in progress there is no turn to attribute to; it falls back to the gadget
    // identity.
    expect(await commitAs({ from: "agent", chatId: 1 }))
        .toEqual({ name: "My Workspace", email: OWNER });
  }));

  it("rejects commits the workspace doesn't know", () => withImpl(async impl => {
    let git = await openGit(impl);
    await expect(git.newWorktree("feed".repeat(10))).rejects.toThrow(/not known/);
    await expect(git.newWorktree("main")).rejects.toThrow(/not a full git commit id/);
  }));

  it("requires full, exact commit ids", () => withImpl(async impl => {
    // Knowing a commit's id is the capability to read it, so a guessable prefix must not work --
    // not even for a commit the workspace has.
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let git = await openGit(impl);
    let worktree = await git.newWorktree(c1);
    for (let id of [c1.slice(0, 8), c1.slice(0, 39), c1.toUpperCase()]) {
      await expect(git.newWorktree(id)).rejects.toThrow(/not a full git commit id/);
      await expect(git.readCommit(id)).rejects.toThrow(/not a full git commit id/);
      await expect(worktree.diff(id)).rejects.toThrow(/not a full git commit id/);
    }
  }));
});

describe("env.GIT readCommit", () => {
  it("reads a commit's metadata", () => withImpl(async impl => {
    // A hand-written merge commit with distinct author and committer time zones, stored alone:
    // neither its tree nor its parents are local, and readCommit needs none of them.
    let payload = new TextEncoder().encode(
        `tree ${TREE_1}\n` +
        `parent ${COMMIT_1}\n` +
        `parent ${COMMIT_2}\n` +
        `author Alice Example <alice@example.com> 1700000000 -0500\n` +
        `committer Bob Example <bob@example.com> 1700000300 +0130\n` +
        `\n` +
        `Merge things\n\nWith a body.\n`);
    let oid: string = await impl.gitCache.putFromGatekeeper(999, "commit", payload);
    using git = new RpcStub(await openGit(impl));

    expect(await git.readCommit(oid)).toEqual({
      parents: [COMMIT_1, COMMIT_2],
      message: "Merge things\n\nWith a body.\n",
      author: {
        name: "Alice Example", email: "alice@example.com",
        timestamp: new Date(1700000000_000), utcOffsetMinutes: -300,
      },
      committer: {
        name: "Bob Example", email: "bob@example.com",
        timestamp: new Date(1700000300_000), utcOffsetMinutes: 90,
      },
    });
  }));

  it("reads commits made through a worktree", () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let git = await openGit(impl);
    let worktree = await git.newWorktree(c1);
    await worktree.writeFile("a.txt", "two\n");
    let c2 = await worktree.commit("second");

    let root = await git.readCommit(c1);
    expect(root.parents).toEqual([]);
    expect(root.message).toBe("test commit\n");
    expect(root.author.utcOffsetMinutes).toBe(0);
    expect(Object.is(root.author.utcOffsetMinutes, 0)).toBe(true);

    let child = await git.readCommit(c2);
    expect(child.parents).toEqual([c1]);
    expect(child.message).toBe("second\n");
    expect(child.author).toMatchObject({ name: "My Workspace", email: OWNER });
    expect(child.committer).toEqual(child.author);
    // Neither the tree nor the (already known) commit id is included.
    expect(Object.keys(child).toSorted())
        .toEqual(["author", "committer", "message", "parents"]);
  }));

  it("pulls only the commit object for a commit known from a gatekeeper",
      () => withImpl(async impl => {
    impl.gitCache.advertiseCommit(999, COMMIT_2);
    let pulls: { oids: string[], hints: GitPullHints }[] = [];
    impl.gitCache.puller = {
      pull: async (gatekeeperId: number, oids: string[], hints: GitPullHints) => {
        pulls.push({ oids, hints });
        for (let object of FIXTURE_OBJECTS.filter(candidate => oids.includes(candidate.oid))) {
          await impl.gitCache.putFromGatekeeper(gatekeeperId, object.type, b64Bytes(object.payload));
        }
      },
    };
    let git = await openGit(impl);

    let info = await git.readCommit(COMMIT_2);
    expect(info.parents).toEqual([COMMIT_1]);
    expect(info.message).toBe("second commit\n");
    expect(pulls).toEqual([{ oids: [COMMIT_2], hints: expect.objectContaining(
        { type: "commit", filterTreeDepth: 0 }) }]);
    expect(storedOids(impl)).toEqual([COMMIT_2]);

    // A worktree rooted at the now-local commit can commit untouched without its tree: the new
    // commit reuses the base's tree oid, so nothing is pulled.
    pulls = [];
    let worktree = await git.newWorktree(COMMIT_2);
    let commit = await worktree.commit("untouched");
    expect(await impl.gitStore.commitTree(commit)).toBe(await impl.gitStore.commitTree(COMMIT_2));
    expect(pulls).toEqual([]);
  }));

  it("rejects commits the workspace doesn't know, and non-commits", () => withImpl(async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    let tree: string = await impl.gitStore.commitTree(c1);
    let git = await openGit(impl);
    await expect(git.readCommit("feed".repeat(10))).rejects.toThrow(/not known/);
    await expect(git.readCommit("main")).rejects.toThrow(/not a full git commit id/);
    await expect(git.readCommit(tree)).rejects.toThrow(/is a tree, not a commit/);
  }));
});

describe("env.GIT presence", () => {
  it("is in every gadget's env, beneath a legacy binding of the same name",
      () => withImpl(async impl => {
    // Observe the loopback targets rather than opaque service stubs.
    impl.makeBindingLoopback = (target: unknown) => target;
    seedGadget(impl, 100);
    expect(impl.getEnvForLoader(100, { from: "gadget", gadgetId: 100 })).toEqual({
      GADGET: { type: "gadget", id: 100 },
      GIT: { type: "git" },
    });

    // A binding named GIT from before the name was reserved still wins.
    impl.storage.gatekeepers.put({ id: 1, resourceTitle: "Conn", class: {} as any });
    seedGadget(impl, 101, { GIT: { target: 1 } });
    expect(impl.getEnvForLoader(101, { from: "gadget", gadgetId: 101 }).GIT)
        .toEqual({ type: "gatekeeper", id: 1 });
  }));

  it("is in the agent's executeCode env, beneath a chat binding of the same name",
      () => withImpl(async impl => {
    impl.makeBindingLoopback = (target: unknown) => target;
    expect(impl.getEnvForAgent(1, {}, "exec-1")).toEqual({ GIT: { type: "git" } });

    impl.storage.gatekeepers.put({ id: 1, resourceTitle: "Conn", class: {} as any });
    expect(impl.getEnvForAgent(1, { GIT: { type: "workpiece", id: 1 } }, "exec-1"))
        .toEqual({ GIT: { type: "gatekeeper", id: 1 } });
  }));

  it("reserves the name for new gadget bindings", () => withImpl(async impl => {
    impl.storage.gatekeepers.put({ id: 1, resourceTitle: "Conn", class: {} as any });
    seedGadget(impl, 100, { CONN: { target: 1 } });
    expect(() => impl.bindWorkpiece(100, "GIT", 1)).toThrow(/`GIT` is reserved/);
    expect(() => impl.renameBinding(100, "CONN", "GIT")).toThrow(/`GIT` is reserved/);
  }));

  it("reserves the name in new chat seeds, renaming legacy entries",
      () => withImpl(async impl => {
    // A legacy gadget binding named GIT (in the default binding list), and an ambient resource
    // whose gatekeeper suggests the name.
    impl.storage.gatekeepers.put({ id: 1, resourceTitle: "Conn", class: {} as any });
    impl.storage.gatekeepers.put({ id: 2, resourceTitle: "Ambient", class: {} as any,
                                   creationSpec: { type: "ambient", vendorId: "v" } });
    impl.getGatekeeperFacet = () => ({
      describe: async () =>
          ({ title: "T", url: "https://example.com", suggestedBindingName: "GIT" }),
      getAgentCatalog: async () => null,
    });
    seedGadget(impl, 100, { GIT: { target: 1 } });
    for (let id of [1, 2]) {
      impl.storage.chatMeta.put(
          { id, title: "Chat", started: new Date(0), lastActive: new Date(id) });
    }

    await impl.prepareChatBindings(1, []);
    expect(impl.getChatAgentContext(1).bindings).toEqual({ G100: 100, GIT_2: 1, GIT_3: 2 });
    expect(impl.chatScopeNames(1)).toContain("GIT");

    // A chat seeded before the reservation keeps its GIT binding.
    impl.storage.chatContext.put({ chatId: 2, bindings: { GIT: 1 } });
    await impl.prepareChatBindings(2, []);
    expect(impl.getChatAgentContext(2).bindings).toMatchObject({ GIT: 1 });
  }));

  it("reserves the name in agent spawner envs", async () => {
    let stub = env.TEST_OVERSEER.getByName(`git-binding-${++doCounter}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      let ownerId = impl.users.newUniqueId().toString();
      impl.ownerId = ownerId;
      impl.ensureAmbientCapsules = async () => {};
      impl.markOutputsDirty = () => {};
      let client = await instance.open(
          ownerId, "owner-profile", new RpcStub<() => void>(() => {}));
      seedGadget(impl, 100);
      await expect(client.newAgentSpawnerGatekeeper(
          { displayName: "Spawner", modelId: "m", env: { GIT: 100 } }))
          .rejects.toThrow(/`GIT` is reserved/);
    });
  });

  it("describeBinding serves the Git and Worktree API", () => withImpl(async impl => {
    let description = impl.describeGitBinding("env.GIT");
    expect(description).toContain("Binding: env.GIT");
    expect(description).toContain("export interface Git");
    expect(description).toContain("newWorktree(commitId: string): Promise<Worktree>");
    expect(description).toContain("readCommit(commitId: string): Promise<CommitMetadata>");
    expect(description).toContain("export type CommitMetadata");
    expect(description).toContain("export interface Worktree");
    expect(description).not.toContain("BEGIN AGENT API");
  }));
});
