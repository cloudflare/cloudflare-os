import { describe, expect, it } from "vitest";
import { RpcStub, env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { GitImpl } from "../src/git-binding";
import { COMMIT_1, FIXTURE_OBJECTS, PACKED_OIDS, b64Bytes } from "./git-cache-fixtures";

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
async function withImpl(fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`git-binding-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerProfileId = OWNER;
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
    // An abbreviated id resolves like createWorktree's.
    let worktree = await git.newWorktree(COMMIT_1.slice(0, 8));

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
  }));

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
    await expect(git.newWorktree("main")).rejects.toThrow(/not a git commit id/);
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

  it("describeBinding serves the Git and Worktree API", () => withImpl(async impl => {
    let description = impl.describeGitBinding("env.GIT");
    expect(description).toContain("Binding: env.GIT");
    expect(description).toContain("export interface Git");
    expect(description).toContain("newWorktree(commitId: string): Promise<Worktree>");
    expect(description).toContain("export interface Worktree");
    expect(description).not.toContain("BEGIN AGENT API");
  }));
});
