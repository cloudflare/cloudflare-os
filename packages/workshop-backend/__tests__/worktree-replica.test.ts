import {describe, expect, it} from "vitest";
import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import type {OverseerDurableObject} from "./test-worker";
import {abortAllDurableObjects} from "cloudflare:test";
import {createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type TranscriptContext} from "@earendil-works/pi-ai";
import {buildPackStream, concatBytes, decodePackStream, encodeGitTree, gitObjectOid, parseGitTree,
  type PackableObject} from "../src/git-codec";
import {runAgent} from "../src/agent";
import {byteStream} from "./git-cache-fixtures";
import type {GitPullTransfer} from "@gadgets/workshop-shared/gatekeeper";
import type {WorktreeGitPullHints} from "@gadgets/workshop-shared/worktree-replica";

const testEnv = env as Cloudflare.Env & {
  TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
};
type Impl = OverseerDurableObject["impl"];
const author = {type: "agent" as const, id: "test", name: "Test"};
async function setup(impl: Impl) {
  impl.storage.chatMeta.put({id: 1, title: "Mounted worktree", started: new Date(), lastActive: new Date()});
  const commit = await impl.gitCache.writeFilesAsCommit(new Map([
    ["a.txt", "abc"], ["untouched.txt", "base"], ["raw.bin", "\0binary\xff"],
  ]), {parents: [], author: {name: "Test", email: "test@example.com"}, message: "Base", timestamp: new Date(0)});
  const tree = await impl.createWorktree("Repo", 1, commit);
  await impl.commitAgentStep(1, author, [], {changes: [], createdGadgets: [],
    createdWorktrees: [{worktreeId: tree.id, title: "Repo", bindingName: "REPO"}],
    addedBindings: [], worktreeCommits: [], blueprintMerges: []});
  impl.storage.chatContext.put({chatId: 1, bindings: {REPO: tree.id}});
  return {tree, commit};
}
async function within(test: (impl: Impl, f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  await runInDurableObject(testEnv.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
    await test(instance.impl, await setup(instance.impl));
  });
}
const text = async (impl: Impl, id: number, path = "a.txt") =>
  (await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!)).get(id)?.get(path);
const step = (impl: Impl, id: number, path: string, set: string) =>
  impl.commitAgentStep(1, author, [], {changes: [{change: {[id]: [[path, {set}]]}}], createdGadgets: [],
    createdWorktrees: [], addedBindings: [], worktreeCommits: [], blueprintMerges: []});
// The WorktreeReplicator a gatekeeper keeps, restored after the execution it came from ended.
const mounted = (impl: Impl, worktreeId: number): Promise<Replicator & Disposable> =>
  impl.ctx.restore({type: "worktreeReplicator", worktreeId});
// Fetch `want` through the stub and list the pack's objects.
async function transfer(worktree: Pick<Replicator, "gitPull">, want: string, haves?: string[]) {
  using pulled = await worktree.gitPull([want], {commitHistory: {kind: "full"}, haves});
  const objects = [];
  const bases = new Map<string, PackableObject>();
  for await (const object of decodePackStream(
      byteStream(new Uint8Array(await new Response(await pulled.stream()).arrayBuffer())),
    {maxPackSize: 1024 * 1024, maxObjectSize: 1024 * 1024, resolveBase: oid => bases.get(oid)})) {
    bases.set(object.oid, object);
    objects.push({oid: object.oid, type: object.type, binary: object.payload.includes(0)});
  }
  return objects;
}

// A connection with provenance for the worktree's base commit. Deliberately not one of the
// chat's bindings: mounting the worktree is what permits fetching its history.
async function connectGitSource(impl: Impl, commit: string, ids = [40]) {
  for (const id of ids) impl.storage.gatekeepers.put({id, class: impl.ctx.exports.ReplicaGitSource({}),
    creationSpec: {type: "gatekeeper", vendorId: "github", typeUrlPattern: "https://github.com/*/*",
      resourceUrl: "https://github.com/fixture/repo"}});
  impl.storage.gitObjectMetadata.put({oid: commit, type: "commit", onRemote: ids, pullableFrom: [], pendingPush: []});
  const facets = await Promise.all(ids.map(id => impl.getGatekeeperFacet(id)));
  return facets as unknown as Fetcher<import("./test-worker").ReplicaGitSource>[];
}
const ANCESTOR = "ab".repeat(20);
const depth = (commits: number): WorktreeGitPullHints => ({commitHistory: {kind: "depth", depth: commits}});
const FULL: WorktreeGitPullHints = {commitHistory: {kind: "full"}};
// Pull `oids` of worktree `id`, as the replica methods of its stub do.
const pull = (impl: Impl, id: number, oids: string[], hints = depth(1)) => impl.worktreeGitPull(id, oids, hints);
const dispose = (pulled: GitPullTransfer) => (pulled as GitPullTransfer & Disposable)[Symbol.dispose]();
// Commit `files` on top of the worktree's head, as the agent's commit() does.
async function commitOnHead(impl: Impl, id: number, files: [string, string][]) {
  const previousHead = impl.getWorktreeRecord(id).headCommit;
  const commit = await impl.gitCache.writeChangedFilesAsCommit(new Map(files), {
    treeBase: previousHead, parents: [previousHead], author: {name: "Test", email: "test@example.com"},
    message: "Explicit worktree commit", timestamp: new Date(),
  });
  await impl.commitAgentStep(1, author, [], {changes: [], createdGadgets: [], createdWorktrees: [],
    addedBindings: [], worktreeCommits: [{worktreeId: id, commit, previousHead}], blueprintMerges: []});
  return commit;
}

// Merge a commit from connections `ids` into the worktree's head, as the agent's commit() of a
// merge does.
async function mergeOnHead(impl: Impl, id: number, ids: number[]) {
  const previousHead = impl.getWorktreeRecord(id).headCommit;
  const merged = await impl.gitCache.writeFilesAsCommit(new Map([["a.txt", "abc"], ["other.txt", "other"]]),
    {parents: [], author: {name: "Test", email: "test@example.com"}, message: "Other", timestamp: new Date(0)});
  const sources = await connectGitSource(impl, merged, ids);
  const commit = await impl.gitCache.writeChangedFilesAsCommit(new Map([["other.txt", "other"]]), {
    treeBase: previousHead, parents: [previousHead, merged], author: {name: "Test", email: "test@example.com"},
    message: "Merge", timestamp: new Date(),
  });
  await impl.commitAgentStep(1, author, [], {changes: [], createdGadgets: [], createdWorktrees: [],
    addedBindings: [], worktreeCommits: [{worktreeId: id, commit, previousHead}], blueprintMerges: []});
  return {head: commit, merged, sources};
}

describe("mounted worktree Git fetches", () => {
  it("serves the worktree's Git head after its execution ended", () => within(async (impl, f) => {
    await step(impl, f.tree.id, "a.txt", "committed");
    const head = await commitOnHead(impl, f.tree.id, [["a.txt", "committed"]]);
    await step(impl, f.tree.id, "a.txt", "committed + pending");
    using worktree = await mounted(impl, f.tree.id);
    expect(await worktree.gitHead()).toBe(head);
    const objects = await transfer(worktree, head);
    expect(objects).toContainEqual({oid: head, type: "commit", binary: false});
    expect(objects).toContainEqual({oid: f.commit, type: "commit", binary: false});
    expect(objects).toContainEqual(expect.objectContaining({type: "blob", binary: true}));
    expect(await text(impl, f.tree.id)).toBe("committed + pending");
  }));

  it("sends only what a fetch of a new head lacks", () => within(async (impl, f) => {
    const head = await commitOnHead(impl, f.tree.id, [["a.txt", "moved"]]);
    using worktree = await mounted(impl, f.tree.id);
    const objects = await transfer(worktree, head, [f.commit]);
    expect(objects.map(object => object.type).toSorted()).toEqual(["blob", "commit", "tree"]);
    expect(objects).toContainEqual({oid: head, type: "commit", binary: false});
  }));

  it("proxies a fetch of an ancestor once its connection confirms it", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    const pulled = await pull(impl, f.tree.id, [ANCESTOR]);
    expect((await pulled.shallowInfo()).shallow).toContain(ANCESTOR);
    const reader = (await pulled.stream()).getReader();
    const [check, forwarded] = await source.requests();
    expect(check).toContain(`want ${ANCESTOR}\n`);
    expect(check).toContain(`have ${f.commit}\n`);
    expect(forwarded).toContain(`want ${ANCESTOR}\n`);
    expect(forwarded).toContain("deepen 1\n");
    await reader.cancel();
  }));

  it("refuses a commit outside the worktree's history without forwarding the fetch", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    await source.setUnrelated(ANCESTOR);
    await expect(pull(impl, f.tree.id, [ANCESTOR]))
      .rejects.toThrow("Only commits in the worktree's history can be fetched.");
    expect(await source.requests()).toHaveLength(1);
  }));

  it("asks the next connection when one doesn't find the commit in the history it knows", () => within(async (impl, f) => {
    const [first, second] = await connectGitSource(impl, f.commit, [40, 41]);
    await first.setUnrelated(ANCESTOR);
    dispose(await pull(impl, f.tree.id, [ANCESTOR]));
    expect(await first.requests()).toHaveLength(1);
    expect(await second.requests()).toHaveLength(2);
  }));

  it("refuses malformed pulls without forwarding them", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    await expect(pull(impl, f.tree.id, [`${ANCESTOR}\ndeepen-not main`])).rejects.toThrow("Invalid object ID");
    await expect(pull(impl, f.tree.id, [ANCESTOR], depth(0))).rejects.toThrow("Invalid depth");
    await expect(pull(impl, f.tree.id, [])).rejects.toThrow("wants nothing");
    expect(await source.requests()).toHaveLength(0);
  }));

  it("proxies a deepen of the head the client already has, without a history check", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    dispose(await pull(impl, f.tree.id, [f.commit],
      {haves: [f.commit], shallow: [f.commit], commitHistory: {kind: "relative", depth: 3}}));
    const [forwarded, ...rest] = await source.requests();
    expect(rest).toEqual([]);
    for (const line of [`want ${f.commit}`, `shallow ${f.commit}`, "deepen 3", "deepen-relative", `have ${f.commit}`])
      expect(forwarded).toContain(`${line}\n`);
  }));

  it("proxies a deeper clone of a worktree still at its remote base", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    dispose(await pull(impl, f.tree.id, [f.commit], depth(2)));
    const [forwarded, ...rest] = await source.requests();
    expect(rest).toEqual([]);
    expect(forwarded).toContain(`want ${f.commit}\n`);
    expect(forwarded).toContain("deepen 2\n");
  }));

  it("proxies a fresh fetch of the base together with an ancestor", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    dispose(await pull(impl, f.tree.id, [f.commit, ANCESTOR]));
    const forwarded = (await source.requests()).at(-1)!;
    expect(forwarded).toContain(`want ${f.commit}\n`);
    expect(forwarded).toContain(`want ${ANCESTOR}\n`);
  }));

  it("deepens past the base after a descendant was pushed", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    const head = await commitOnHead(impl, f.tree.id, [["a.txt", "pushed"]]);
    impl.storage.gitObjectMetadata.put({oid: head, type: "commit", onRemote: [40], pullableFrom: [], pendingPush: []});
    dispose(await pull(impl, f.tree.id, [head],
      {haves: [head], shallow: [f.commit], commitHistory: {kind: "relative", depth: 1}}));
    // From the pushed commit, now the history's boundary.
    const [forwarded, ...rest] = await source.requests();
    expect(rest).toEqual([]);
    for (const line of [`want ${head}`, `have ${head}`, `shallow ${f.commit}`, "deepen-relative"])
      expect(forwarded).toContain(`${line}\n`);
  }));

  it("streams every boundary commit from one connection that has them all, in one request", () => within(async (impl, f) => {
    const [one, both] = await connectGitSource(impl, f.commit, [40, 41]);
    const {head, merged} = await mergeOnHead(impl, f.tree.id, [41]);
    dispose(await pull(impl, f.tree.id, [head], FULL));
    const [forwarded] = await both.requests();
    for (const line of [`want ${f.commit}`, `want ${merged}`, "deepen 1"]) expect(forwarded).toContain(`${line}\n`);
    expect(forwarded).not.toContain(`want ${head}`);
    expect(await one.requests()).toEqual([]);
  }));

  it("refuses a clone when no one connection has every boundary commit", () => within(async (impl, f) => {
    const [first] = await connectGitSource(impl, f.commit, [40]);
    const {head, sources: [second]} = await mergeOnHead(impl, f.tree.id, [41]);
    await expect(pull(impl, f.tree.id, [head], FULL))
      .rejects.toThrow("none of them has all of it");
    expect(await first.requests()).toEqual([]);
    expect(await second.requests()).toEqual([]);
  }));

  it("clones a worktree still at its remote base shallow, at depth 1", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    dispose(await pull(impl, f.tree.id, [f.commit], FULL));
    const [forwarded] = await source.requests();
    expect(forwarded).toContain(`want ${f.commit}\n`);
    expect(forwarded).toContain("deepen 1\n");
  }));

  it("gives a clone deeper than the boundary less history", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    const head = await commitOnHead(impl, f.tree.id, [["a.txt", "moved"]]);
    dispose(await pull(impl, f.tree.id, [head], depth(5)));
    const [forwarded] = await source.requests();
    expect(forwarded).toContain(`want ${f.commit}\n`);
    expect(forwarded).toContain("deepen 1\n");
  }));

  it("refuses a fetch needing both new workspace commits and remote history", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    const head = await commitOnHead(impl, f.tree.id, [["a.txt", "moved"]]);
    await expect(pull(impl, f.tree.id, [head], {haves: [f.commit], shallow: [f.commit], ...depth(5)}))
      .rejects.toThrow("Fetch the worktree's head first, then fetch again.");
    await expect(pull(impl, f.tree.id, [head, ANCESTOR], {haves: [f.commit], ...FULL}))
      .rejects.toThrow("Fetch the worktree's head first, then fetch again.");
    expect(await source.requests()).toHaveLength(0);
  }));

  it("refuses commits the workspace doesn't have when no connection serves the history", () => within(async (impl, f) => {
    await expect(pull(impl, f.tree.id, [ANCESTOR]))
      .rejects.toThrow("No connected repository could serve these commits.");
  }));

  it("fails closed after worktree deletion", () => within(async (impl, f) => {
    using worktree = await mounted(impl, f.tree.id);
    impl.storage.gadgets.delete(f.tree.id);
    await expect(transfer(worktree, f.commit)).rejects.toThrow();
  }));
});

// ---------------------------------------------------------------------------------------------
// Commands: snapshot() and submit()
//
// These run real agent turns (pi's faux provider standing in for the model) through the real
// executeCodeMode, with the worker it loads replaced by a script that gets the execution's
// Worktree binding as the loopback resolves it, and its replicator, as a gatekeeper the agent's
// code passed the binding to would.

type Command = Awaited<ReturnType<Replicator["snapshot"]>>["command"];
type Replicator = {
  snapshot(): Promise<{tree: string; head: string; command: {submit(tree: string, pack: ReadableStream<Uint8Array>): Promise<{tree: string; head: string}>}}>;
  gitHead(): Promise<string>;
  gitPull(oids: string[], hints: WorktreeGitPullHints): Promise<GitPullTransfer & Disposable>;
};
type Binding = {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  getReplicator(): Promise<Replicator>;
};
type Code = (repo: Binding, replicator: Replicator, executionId: string) => Promise<string | void>;
const BASE = {"a.txt": "one\ntwo\nthree\n", "b.txt": "bee\n", "dir/c.txt": "sea\n"};
const enc = (value: string) => new TextEncoder().encode(value);

async function withCommands(test: (impl: Impl, id: number, base: string) => Promise<void>, name?: string) {
  await runInDurableObject(testEnv.TEST_OVERSEER.getByName(name ?? crypto.randomUUID()), async instance => {
    const impl = instance.impl;
    impl.storage.chatMeta.put({id: 1, title: "Chat", started: new Date(0), lastActive: new Date(0)});
    const base = await impl.gitCache.writeFilesAsCommit(new Map(Object.entries(BASE)),
      {parents: [], author: {name: "Test", email: "test@example.com"}, message: "Base", timestamp: new Date(0)});
    const {id} = await impl.createWorktree("Repo", 1, base);
    await impl.commitAgentStep(1, author, [], {changes: [], createdGadgets: [], addedBindings: [],
      worktreeCommits: [], blueprintMerges: [], createdWorktrees: [{worktreeId: id, title: "Repo", bindingName: "REPO"}]});
    await test(impl, id, base);
  });
}

// Runs each executeCode call's code as the script `code[name]`, given the worktree's binding.
function runCode(impl: Impl, id: number, code: Record<string, Code>) {
  const getEnv = impl.getEnvForAgent.bind(impl);
  let executionId!: string;
  impl.getEnvForAgent = (chatId, bindings, execution) => {
    executionId = execution;
    return getEnv(chatId, bindings, execution);
  };
  const loader = {load: (worker: {modules: Record<string, string>}) => ({getEntrypoint: () => ({
    verify: async () => {},
    run: async () => {
      const execution = executionId;
      let output: string | void = "";
      try {
        const repo = await impl.startGatekeeperSession({type: "worktree", id, executionId: execution}, {from: "agent", chatId: 1});
        output = await code[worker.modules["agent.js"]](repo, await repo.getReplicator(), execution);
      } finally {
        await impl.deliverCodeModeTrace(execution, {logs: output ? [{message: [output]}] : []} as never);
      }
    },
  })})};
  impl.env = new Proxy(impl.env, {get: (target, key) => key === "LOADER" ? loader : Reflect.get(target, key, target)});
}

// One agent turn whose model makes each step's calls and then stops; returns each call's result.
async function turn(impl: Impl, steps: ReturnType<typeof fauxToolCall>[][], signal = new AbortController().signal) {
  impl.storage.chats.put({chatId: 1, sequence: impl.nextChatSequence(1), timestamp: impl.getChatTimestamp(),
    author: {type: "user", id: "alice@example.com", name: "Alice"}, type: "message", message: "Go."});
  const faux = createFauxCore({models: [{id: "faux-model"}]});
  let last: TranscriptContext["messages"] = [];
  faux.setResponses([...steps.map(calls => fauxAssistantMessage(calls, {stopReason: "toolUse"})),
    fauxAssistantMessage(fauxText("Done."))].map(response => (context: TranscriptContext) => {
    last = structuredClone(context.messages);
    return response;
  }));
  await runAgent(impl, {model: faux.getModel(), stream: faux.stream}, 1, author, signal,
    {type: "user", id: "alice@example.com", name: "Alice"}, {provider: "cloudflare", model: "faux-model", apiToken: ""} as never);
  const results = last.flatMap(message => message.role === "toolResult"
    ? [message.content.map(part => part.type === "text" ? part.text : "").join("")] : []);
  return results.slice(-steps.flat().length);
}
const execute = (code: string) => fauxToolCall("executeCode", {code});
const read = (filename: string) => fauxToolCall("readFile", {workpiece: "REPO", filename});

// Every object reachable from a tree.
function reachable(impl: Impl, tree: string, out = new Set<string>()) {
  if (out.has(tree)) return out;
  out.add(tree);
  for (const entry of parseGitTree(impl.gitCache.readLocalObject(tree)!.payload)) {
    if (entry.mode === "40000") reachable(impl, entry.oid, out); else out.add(entry.oid);
  }
  return out;
}

// What a container would submit after a command that made `edits` to a checkout of `from`: the
// tree, and a pack of what `from` lacks. Those objects are then dropped from the store, so that
// only the pack supplies them.
async function commandResult(impl: Impl, from: string,
    edits: Record<string, string | null | {mode: string; text: string}>, keep = false) {
  // Deletions first, so that a file can become a directory.
  const deleted = Object.keys(edits).filter(path => edits[path] === null);
  let tree: string = await impl.gitCache.writeChangedTreeOf(from, new Map(deleted.map(path => [path, null])));
  const changes = new Map<string, unknown>();
  for (const [path, edit] of Object.entries(edits)) {
    if (edit !== null) changes.set(path, typeof edit === "string" ? edit
      : {mode: edit.mode, oid: (await impl.gitCache.writeBlob(enc(edit.text))).oid});
  }
  tree = await impl.gitCache.writeChangedTreeOf(tree, changes as never);
  return packedResult(impl, from, tree, keep);
}

// `commandResult` for a tree already in the store.
function packedResult(impl: Impl, from: string, tree: string, keep = false) {
  const old = reachable(impl, from);
  const objects = [...reachable(impl, tree)].filter(oid => !old.has(oid))
    .map(oid => ({oid, ...impl.gitCache.readLocalObject(oid)!}));
  if (!keep) for (const {oid} of objects) impl.storage.gitObjects.delete(oid);
  return {tree, pack: () => buildPackStream(objects.length, (async function* () { yield* objects; })())};
}

// Tree `tree` with a file holding `text` at `path`, written by hand: the store refuses to write
// the names Git reserves, which a container's tree may still hold.
function treeWithFile(impl: Impl, tree: string | undefined, path: string, text: string): string {
  const [name, ...rest] = path.split("/");
  const entries = tree === undefined ? [] : parseGitTree(impl.gitCache.readLocalObject(tree)!.payload);
  const old = entries.find(entry => entry.name === name);
  const object = rest.length ? {type: "tree" as const, oid: treeWithFile(impl, old?.oid, rest.join("/"), text)}
    : {type: "blob" as const, payload: enc(text)};
  const oid = "oid" in object ? object.oid : gitObjectOid("blob", object.payload);
  if (!("oid" in object)) impl.gitCache.importObjects([object]);
  const payload = encodeGitTree([...entries.filter(entry => entry !== old),
    {mode: rest.length ? "40000" : "100644", name, oid}]);
  impl.gitCache.importObjects([{type: "tree", payload}]);
  return gitObjectOid("tree", payload);
}

// A tree's files, by path.
async function treeFiles(impl: Impl, tree: string, prefix = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of parseGitTree(impl.gitCache.readLocalObject(tree)!.payload)) {
    if (entry.mode === "40000") Object.assign(out, await treeFiles(impl, entry.oid, `${prefix}${entry.name}/`));
    else out[prefix + entry.name] = new TextDecoder().decode(impl.gitCache.readLocalObject(entry.oid)!.payload);
  }
  return out;
}
const pins = (impl: Impl) => impl.storage.chatMeta.get(1)!.codeBase?.pins ?? [];

describe("worktree commands", () => {
  it("fail outside an execution", () => withCommands(async (impl, id) => {
    using worktree = await mounted(impl, id);
    expect(await worktree.snapshot().then(() => "", (error: Error) => error.message))
      .toMatch("only while the agent's code runs in its chat");
  }));

  it("submit a command's result into the step, which saves it with its transcript", () => withCommands(async (impl, id, base) => {
    let snapshot!: Awaited<ReturnType<Replicator["snapshot"]>>, result!: string, returned: unknown;
    runCode(impl, id, {
      command: async (repo, replicator) => {
        await repo.writeFile("a.txt", "one\ntwo\nthree\nbuffered\n");
        snapshot = await replicator.snapshot();
        const command = await commandResult(impl, snapshot.tree,
          {"b.txt": "formatted\n", "new/d.txt": "dee\n", "dir/c.txt": {mode: "100755", text: "sea\n"}});
        result = command.tree;
        returned = await snapshot.command.submit(command.tree, command.pack());
        return `${await repo.readFile("a.txt")}|${await repo.readFile("b.txt")}`;
      },
    });
    expect(await turn(impl, [[execute("command")]])).toEqual(["one\ntwo\nthree\nbuffered\n|formatted\n"]);
    // The snapshot held the step's buffered write; the submission's result is the submitted tree.
    expect(snapshot.head).toBe(base);
    expect(returned).toEqual({tree: result, head: base});
    expect(await treeFiles(impl, result)).toEqual({"a.txt": "one\ntwo\nthree\nbuffered\n", "b.txt": "formatted\n",
      "dir/c.txt": "sea\n", "new/d.txt": "dee\n"});
    // The step re-rooted the chat's pin at a hidden commit of it, on the accepted commit.
    const [pin] = pins(impl);
    expect(pin).toEqual({gadgetId: id, baseCommit: expect.any(String), mergedCommit: base});
    expect(await impl.gitCache.commitTree(pin.baseCommit)).toBe(result);
    expect((await impl.gitCache.readCommitObject(pin.baseCommit)).parents).toEqual([base]);
    expect(await turn(impl, [[read("a.txt"), read("new/d.txt")]])).toEqual(["one\ntwo\nthree\nbuffered\n", "dee\n"]);
    // Accepting keeps the executable bit.
    expect(await impl.mergeChanges(1, {profile: {type: "user", id: "alice@example.com", name: "Alice"}}, "alice-user-do"))
      .toEqual({outcome: "merged"});
    expect((await impl.gitCache.pathEntryAtCommit(impl.getWorktreeRecord(id).pinBase, "dir/c.txt"))!.kind).toBe("executable");
  }));

  it("serves the execution's trees by ID, and only during it", () => withCommands(async (impl, id, base) => {
    let tree!: string;
    let during: Awaited<ReturnType<typeof transfer>> = [];
    runCode(impl, id, {
      command: async (repo, replicator) => {
        await repo.writeFile("b.txt", "edited\n");
        tree = (await replicator.snapshot()).tree;
        during = await transfer(replicator, tree, [base]);
      },
    });
    await turn(impl, [[execute("command")]]);
    // Only what the client's commit lacks: the new root tree and blob.
    expect(during.map(object => object.type).toSorted()).toEqual(["blob", "tree"]);
    expect(during).toContainEqual({oid: tree, type: "tree", binary: true});
    using worktree = await mounted(impl, id);
    await expect(transfer(worktree, tree, [base])).rejects.toThrow();
  }));

  it("keeps working through a replicator an earlier execution handed out, unlike its binding", () => withCommands(async (impl, id) => {
    let kept!: Replicator, first!: string, refused!: string;
    runCode(impl, id, {
      mount: async (_, replicator, execution) => { kept = replicator; first = execution; },
      command: async () => {
        // As a gatekeeper that stored the earlier execution's binding would: it no longer resolves.
        refused = await (async () => impl.startGatekeeperSession({type: "worktree", id, executionId: first},
          {from: "agent", chatId: 1}))().then(() => "", (error: Error) => error.message);
        const snapshot = await kept.snapshot();
        const command = await commandResult(impl, snapshot.tree, {"b.txt": "submitted\n"});
        await snapshot.command.submit(command.tree, command.pack());
      },
    });
    await turn(impl, [[execute("mount")], [execute("command")]]);
    expect(refused).toMatch(/no longer live/);
    expect(await turn(impl, [[read("b.txt")]])).toEqual(["submitted\n"]);
    expect(await transfer(kept, impl.getWorktreeRecord(id).headCommit)).not.toEqual([]);
  }));

  it("returns the first result on a retry, even after a conflicting merge, and refuses another", () => withCommands(async (impl, id) => {
    let results: unknown[] = [];
    runCode(impl, id, {
      command: async (repo, replicator) => {
        const snapshot = await replicator.snapshot();
        await repo.writeFile("a.txt", "one\nworkspace\nthree\n");
        const command = await commandResult(impl, snapshot.tree, {"a.txt": "one\ncommand\nthree\n"});
        const first = await snapshot.command.submit(command.tree, command.pack());
        const again = await snapshot.command.submit(command.tree, command.pack());
        const other = await commandResult(impl, snapshot.tree, {"b.txt": "other\n"});
        results = [first, again, await snapshot.command.submit(other.tree, other.pack())
          .catch((error: Error) => error.message), await repo.readFile("a.txt")];
        return "ran";
      },
    });
    const [output] = await turn(impl, [[execute("command")]]);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toMatch(/already submitted/);
    expect(results[3]).toBe("one\n<<<<<<< workspace\nworkspace\n||||||| snapshot\ntwo\n=======\ncommand\n>>>>>>> command\nthree\n");
    expect(await treeFiles(impl, (results[0] as {tree: string}).tree)).toMatchObject({"a.txt": results[3]});
    expect(output).toContain("merged with concurrent edits, with conflicts in: a.txt");
    expect(output).toContain("in REPO");
  }));

  it("keeps everyone's edits across parallel submissions and a write during one", () => withCommands(async (impl, id) => {
    runCode(impl, id, {
      command: async (repo, replicator) => {
        const [first, second] = [await replicator.snapshot(), await replicator.snapshot()];
        expect(second.tree).toBe(first.tree);
        const one = await commandResult(impl, first.tree, {"b.txt": "bee\none\n"}, true);
        const two = await commandResult(impl, first.tree, {"a.txt": "one\ntwo\nthree\ntwo\n"}, true);
        // The agent's code writes while the first submission is writing the tree of the
        // worktree's current files.
        const writeTree = impl.gitCache.writeChangedTree.bind(impl.gitCache);
        let wrote = false;
        impl.gitCache.writeChangedTree = async (...args) => {
          const tree = await writeTree(...args);
          if (!wrote) { wrote = true; await repo.writeFile("dir/c.txt", "written\n"); }
          return tree;
        };
        await Promise.all([first.command.submit(one.tree, one.pack()), second.command.submit(two.tree, two.pack())]);
        return "ran";
      },
    });
    await turn(impl, [[execute("command")]]);
    expect(await turn(impl, [[read("a.txt"), read("b.txt"), read("dir/c.txt")]]))
      .toEqual(["one\ntwo\nthree\ntwo\n", "bee\none\n", "written\n"]);
  }));

  it("merges modes on their own, and keeps a file replaced by a directory with a parallel edit", () => withCommands(async (impl, id) => {
    let result!: string;
    runCode(impl, id, {
      command: async (repo, replicator) => {
        const snapshots = [await replicator.snapshot(), await replicator.snapshot(), await replicator.snapshot()];
        const from = snapshots[0].tree;
        const results = [
          await commandResult(impl, from, {"dir/c.txt": {mode: "100755", text: "sea\n"}}, true),
          await commandResult(impl, from, {"b.txt": null, "b.txt/inner": "in\n"}, true),
          await commandResult(impl, from, {"dir/c.txt": "sea\nedited\n"}, true),
        ];
        for (const [i, {tree, pack}] of results.entries()) result = (await snapshots[i].command.submit(tree, pack())).tree;
        return "ran";
      },
    });
    expect(await turn(impl, [[execute("command")]])).toEqual(["ran"]);
    expect(await treeFiles(impl, result)).toEqual(
      {"a.txt": BASE["a.txt"], "b.txt/inner": "in\n", "dir/c.txt": "sea\nedited\n"});
    const dir = parseGitTree(impl.gitCache.readLocalObject(result)!.payload).find(entry => entry.name === "dir")!;
    expect(parseGitTree(impl.gitCache.readLocalObject(dir.oid)!.payload)[0].mode).toBe("100755");
  }));

  it("installs nothing if the execution ends during the submission", () => withCommands(async (impl, id, base) => {
    let submitting!: Promise<unknown>;
    let finish!: () => void;
    runCode(impl, id, {
      command: async (repo, replicator) => {
        const snapshot = await replicator.snapshot();
        const command = await commandResult(impl, snapshot.tree, {"b.txt": "late\n"});
        const reader = command.pack().getReader();
        submitting = snapshot.command.submit(command.tree, new ReadableStream({
          async start(controller) {
            await new Promise<void>(resolve => finish = resolve);
            for (let next = await reader.read(); !next.done; next = await reader.read()) controller.enqueue(next.value);
            controller.close();
          },
        }));
        submitting.catch(() => {});
        return "ran";
      },
    });
    await turn(impl, [[execute("command")]]);
    finish();
    await expect(submitting).rejects.toThrow("has ended");
    expect(pins(impl)).toEqual([]);
    expect(await turn(impl, [[read("b.txt")]])).toEqual(["bee\n"]);
    expect(impl.getWorktreeRecord(id).pinBase).toBe(base);
  }));

  it("refuses a handle from an earlier execution", () => withCommands(async (impl, id) => {
    let earlier!: Command;
    let refused: unknown;
    runCode(impl, id, {
      snapshot: async (repo, replicator) => { earlier = (await replicator.snapshot()).command; },
      submit: async (repo, replicator) => {
        const command = await commandResult(impl, (await replicator.snapshot()).tree, {"b.txt": "x\n"});
        refused = await earlier.submit(command.tree, command.pack()).catch((error: Error) => error.message);
      },
    });
    await turn(impl, [[execute("snapshot")], [execute("submit")]]);
    expect(refused).toMatch(/has ended/);
    expect(pins(impl)).toEqual([]);
  }));

  it("is saved with its step when the turn is cancelled while the command runs", () => withCommands(async (impl, id) => {
    const abort = new AbortController();
    runCode(impl, id, {
      command: async (repo, replicator) => {
        const snapshot = await replicator.snapshot();
        const command = await commandResult(impl, snapshot.tree, {"b.txt": "cancelled\n"});
        await snapshot.command.submit(command.tree, command.pack());
        abort.abort();
        return "ran";
      },
    });
    await turn(impl, [[execute("command")]], abort.signal).catch(() => {});
    // The completed call's record and its effects land together, as for any tool's edits.
    expect(pins(impl)).toHaveLength(1);
    expect(await turn(impl, [[read("b.txt")]])).toEqual(["cancelled\n"]);
  }));

  // (The command's handle is lost with the restart too: it was an in-memory stub into the
  // object that restarted.)
  it("is lost if the workspace restarts before the step's barrier", async () => {
    const name = crypto.randomUUID();
    await withCommands(async (impl, id) => {
      let submitted!: () => void;
      const reached = new Promise<void>(resolve => submitted = resolve);
      runCode(impl, id, {
        command: async (repo, replicator) => {
          const snapshot = await replicator.snapshot();
          const result = await commandResult(impl, snapshot.tree, {"b.txt": "crashed\n"});
          await snapshot.command.submit(result.tree, result.pack());
          submitted();
          await new Promise(() => {});
        },
      });
      void turn(impl, [[execute("command")]]).catch(() => {});
      await reached;
      expect(pins(impl)).toEqual([]);
    }, name);
    await abortAllDurableObjects();
    await runInDurableObject(testEnv.TEST_OVERSEER.getByName(name), async instance => {
      const impl = instance.impl;
      expect(pins(impl)).toEqual([]);
      expect(await turn(impl, [[read("b.txt")]])).toEqual(["bee\n"]);
    });
  });

  it("refuses a file replaced by a directory against a concurrent edit of the file", () => withCommands(async (impl, id) => {
    let refused: unknown;
    runCode(impl, id, {
      command: async (repo, replicator) => {
        const snapshot = await replicator.snapshot();
        await repo.writeFile("b.txt", "edited\n");
        const command = await commandResult(impl, snapshot.tree, {"b.txt": null, "b.txt/inner": "x\n"});
        refused = await snapshot.command.submit(command.tree, command.pack()).catch((error: Error) => error.message);
      },
    });
    await turn(impl, [[execute("command")]]);
    expect(refused).toMatch(/both a file and a directory/);
    expect(await turn(impl, [[read("b.txt")]])).toEqual(["edited\n"]);
  }));

  it("refuses symlinks, .git entries and missing objects", () => withCommands(async (impl, id) => {
    const refused: unknown[] = [];
    runCode(impl, id, {
      command: async (repo, replicator) => {
        const snapshot = await replicator.snapshot();
        for (const command of [await commandResult(impl, snapshot.tree, {"link": {mode: "120000", text: "a.txt"}}),
          packedResult(impl, snapshot.tree, treeWithFile(impl, snapshot.tree, ".git/config", "x\n")),
          packedResult(impl, snapshot.tree, treeWithFile(impl, snapshot.tree, "sub/.GIT", "x\n"))]) {
          refused.push(await snapshot.command.submit(command.tree, command.pack()).catch((error: Error) => error.message));
        }
        const command = await commandResult(impl, snapshot.tree, {"b.txt": "lost\n"});
        refused.push(await snapshot.command.submit(command.tree, buildPackStream(0, (async function* () {})()))
          .catch((error: Error) => error.message));
        // A tree no Git would write, with an entry name that hides a path.
        const blob = {type: "blob" as const, payload: enc("x\n")};
        const blobId = await gitObjectOid("blob", blob.payload);
        const tree = {type: "tree" as const, payload: concatBytes([enc("100644 sub/.git/config\0"),
          Uint8Array.from(blobId.match(/../g)!, byte => parseInt(byte, 16))])};
        refused.push(await snapshot.command.submit(await gitObjectOid("tree", tree.payload),
          buildPackStream(2, (async function* () { yield blob; yield tree; })())).catch((error: Error) => error.message));
      },
    });
    await turn(impl, [[execute("command")]]);
    expect(refused).toEqual([expect.stringMatching(/symlinks and submodules/), expect.stringMatching(/\.git entry/),
      expect.stringMatching(/\.git entry/), expect.stringMatching(/neither its pack nor the workspace holds/),
      expect.stringMatching(/is malformed/)]);
    expect(pins(impl)).toEqual([]);
  }));
});
