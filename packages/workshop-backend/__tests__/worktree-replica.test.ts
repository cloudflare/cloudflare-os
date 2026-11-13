import {describe, expect, it} from "vitest";
import {env, RpcStub, RpcTarget} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import type {OverseerDurableObject} from "./test-worker";
import {abortAllDurableObjects} from "cloudflare:test";
import {createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type TranscriptContext} from "@earendil-works/pi-ai";
import {buildPackStream, concatBytes, decodePackStream, encodeGitTree, gitObjectOid, parseGitTree,
  type PackableObject} from "../src/git-codec";
import {runAgent} from "../src/agent";
import {byteStream} from "./git-cache-fixtures";
import {deflateSync} from "node:zlib";
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

  it("proxies a filtered clone without its filter, whose omissions it couldn't serve", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    dispose(await pull(impl, f.tree.id, [f.commit], {...depth(2), filterBlobSize: 0}));
    const [forwarded] = await source.requests();
    expect(forwarded).toContain("deepen 2\n");
    expect(forwarded).not.toContain("filter");
  }));

  it("ends a proxied pack that fails partway with the connection's error", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    await source.setFailing("upstream refused");
    using pulled = await pull(impl, f.tree.id, [f.commit], depth(2));
    const read = await new Response(await pulled.stream()).arrayBuffer().then(() => "", (error: Error) => error.message);
    expect(read).toContain("upstream refused");
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

type State = {tree: string; head: string};
type Queue = object;
type Replicator = {
  snapshot(queue: Queue): Promise<State>;
  submit(queue: Queue, base: string, tree: string, pack: ReadableStream<Uint8Array>): Promise<State>;
  gitHead(): Promise<string>;
  gitPull(oids: string[], hints: WorktreeGitPullHints): Promise<GitPullTransfer & Disposable>;
};
type Binding = {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  getReplicator(): Promise<Replicator>;
};
type Code = (repo: Binding, replicator: Replicator, queue: Queue, executionId: string) => Promise<string | void>;
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

// The ApprovalQueue a gatekeeper session opened by `executionId`'s code receives.
const queueFor = (impl: Impl, executionId: string, chatId = 1) => impl.openGatekeeperSession(
  7, {startSession: (queue: unknown) => queue} as never, {from: "agent", chatId}, executionId) as Promise<Queue>;

// Runs each executeCode call's code as the script `code[name]`, given the worktree's binding, its
// replicator, and the queue of a gatekeeper session the code opened.
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
        // Over RPC, as the loopback resolves it, so what the binding hands out crosses an RPC
        // boundary as it would on its way to a gatekeeper.
        const overseer = testEnv.TEST_OVERSEER.get(impl.ctx.id) as unknown as {startGatekeeperSession: Impl["startGatekeeperSession"]};
        const repo = await overseer.startGatekeeperSession({type: "worktree", id, executionId: execution}, {from: "agent", chatId: 1});
        output = await code[worker.modules["agent.js"]](repo, await repo.getReplicator(), await queueFor(impl, execution), execution);
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
    expect(await worktree.snapshot(await queueFor(impl, "ended")).then(() => "", (error: Error) => error.message))
      .toMatch("only while the agent's code runs in its chat");
  }));

  it("submit a command's result into the step, which saves it with its transcript", () => withCommands(async (impl, id, base) => {
    let snapshot!: Awaited<ReturnType<Replicator["snapshot"]>>, result!: string, returned: unknown;
    runCode(impl, id, {
      command: async (repo, replicator, queue) => {
        await repo.writeFile("a.txt", "one\ntwo\nthree\nbuffered\n");
        snapshot = await replicator.snapshot(queue);
        const command = await commandResult(impl, snapshot.tree,
          {"b.txt": "formatted\n", "new/d.txt": "dee\n", "dir/c.txt": {mode: "100755", text: "sea\n"}});
        result = command.tree;
        returned = await replicator.submit(queue, snapshot.tree, command.tree, command.pack());
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
      command: async (repo, replicator, queue) => {
        await repo.writeFile("b.txt", "edited\n");
        tree = (await replicator.snapshot(queue)).tree;
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
    let first!: string, refused!: string;
    runCode(impl, id, {
      // As a gatekeeper would, it stores the replicator, which it can only if it's persistent.
      mount: async (_, replicator, _queue, execution) => { impl.ctx.storage.kv.put("kept", replicator); first = execution; },
      command: async (_, _replicator, queue) => {
        const kept = impl.ctx.storage.kv.get<Replicator>("kept")!;
        // As a gatekeeper that stored the earlier execution's binding would: it no longer resolves.
        refused = await (async () => impl.startGatekeeperSession({type: "worktree", id, executionId: first},
          {from: "agent", chatId: 1}))().then(() => "", (error: Error) => error.message);
        const snapshot = await kept.snapshot(queue);
        const command = await commandResult(impl, snapshot.tree, {"b.txt": "submitted\n"});
        await kept.submit(queue, snapshot.tree, command.tree, command.pack());
      },
    });
    await turn(impl, [[execute("mount")], [execute("command")]]);
    expect(refused).toMatch(/no longer live/);
    expect(await turn(impl, [[read("b.txt")]])).toEqual(["submitted\n"]);
    expect(await transfer(impl.ctx.storage.kv.get<Replicator>("kept")!, impl.getWorktreeRecord(id).headCommit))
      .not.toEqual([]);
  }));

  it("merges a concurrent edit of the same lines with conflict markers", () => withCommands(async (impl, id) => {
    let result!: State, text!: string;
    runCode(impl, id, {
      command: async (repo, replicator, queue) => {
        const snapshot = await replicator.snapshot(queue);
        await repo.writeFile("a.txt", "one\nworkspace\nthree\n");
        const command = await commandResult(impl, snapshot.tree, {"a.txt": "one\ncommand\nthree\n"});
        result = await replicator.submit(queue, snapshot.tree, command.tree, command.pack());
        text = await repo.readFile("a.txt");
        return "ran";
      },
    });
    const [output] = await turn(impl, [[execute("command")]]);
    expect(text).toBe("one\n<<<<<<< workspace\nworkspace\n||||||| base\ntwo\n=======\ncommand\n>>>>>>> command\nthree\n");
    expect(await treeFiles(impl, result.tree)).toMatchObject({"a.txt": text});
    expect(output).toContain("merged with concurrent edits, with conflicts in: a.txt");
    expect(output).toContain("in REPO");
  }));

  it("builds a submission on an earlier one's tree, even while that one is still merging", () => withCommands(async (impl, id) => {
    let results!: State[], second!: string;
    runCode(impl, id, {
      command: async (repo, replicator, queue) => {
        const snapshot = await replicator.snapshot(queue);
        // The agent's code writes meanwhile, so the first result is a merge, not the tree
        // submitted; the replica submits again from the files it has.
        await repo.writeFile("dir/c.txt", "written\n");
        const one = await commandResult(impl, snapshot.tree, {"b.txt": "bee\none\n"}, true);
        const two = await commandResult(impl, one.tree, {"a.txt": "one\ntwo\nthree\ntwo\n"}, true);
        second = two.tree;
        results = await Promise.all([replicator.submit(queue, snapshot.tree, one.tree, one.pack()),
          replicator.submit(queue, one.tree, two.tree, two.pack())]);
        // Then from the merged result, as a replica that updated its files to it would.
        const three = await commandResult(impl, results[1].tree, {"new.txt": "new\n"});
        results.push(await replicator.submit(queue, results[1].tree, three.tree, three.pack()));
        return "ran";
      },
    });
    expect(await turn(impl, [[execute("command")]])).toEqual(["ran"]);
    expect(results[0].tree).not.toBe(second);
    expect(await treeFiles(impl, results[2].tree)).toEqual({"a.txt": "one\ntwo\nthree\ntwo\n", "b.txt": "bee\none\n",
      "dir/c.txt": "written\n", "new.txt": "new\n"});
  }));

  it("cancels the pack of a submission it refuses before reading it", () => withCommands(async (impl, id) => {
    let outcomes!: unknown[];
    runCode(impl, id, {
      command: async (repo, replicator, queue) => {
        const {tree} = await replicator.snapshot(queue);
        // A pack that never ends unless cancelled. It keeps producing, as an upload would: the
        // RPC pipe carrying it learns of a cancellation on its next write.
        const pending = () => {
          let cancelled!: () => void;
          const done = new Promise<void>(resolve => cancelled = resolve);
          return {done, stream: new ReadableStream<Uint8Array>({
            pull: async controller => {
              await new Promise(resolve => setTimeout(resolve, 10));
              controller.enqueue(new Uint8Array(1));
            },
            cancel: () => cancelled(),
          })};
        };
        const settled = (done: Promise<void>) => Promise.race([done.then(() => true),
          new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000))]);
        const [malformed, unknownBase] = [pending(), pending()];
        outcomes = [
          await failure(replicator.submit(queue, tree, "not a tree ID", malformed.stream)),
          await settled(malformed.done),
          await failure(replicator.submit(queue, "ab".repeat(20), tree, unknownBase.stream)),
          await settled(unknownBase.done),
        ];
        return "ran";
      },
    });
    expect(await turn(impl, [[execute("command")]])).toEqual(["ran"]);
    expect(outcomes).toEqual([expect.stringMatching(/Invalid git object id/), true,
      expect.stringMatching(/base must be a tree/), true]);
  }));

  it("refuses a base the execution didn't hand out or receive", () => withCommands(async (impl, id, base) => {
    let earlier!: string;
    const refused: string[] = [];
    runCode(impl, id, {
      snapshot: async (repo, replicator, queue) => {
        await repo.writeFile("b.txt", "earlier\n");
        earlier = (await replicator.snapshot(queue)).tree;
      },
      submit: async (repo, replicator, queue) => {
        await repo.writeFile("b.txt", "later\n");
        const current = (await replicator.snapshot(queue)).tree;
        expect(current).not.toBe(earlier);
        // The accepted commit's tree, and a tree an earlier execution handed out.
        for (const from of [await impl.gitCache.commitTree(base), earlier]) {
          const command = await commandResult(impl, from, {"a.txt": "stale\n"});
          refused.push(await replicator.submit(queue, from, command.tree, command.pack()).then(() => "", (error: Error) => error.message));
        }
      },
    });
    await turn(impl, [[execute("snapshot")], [execute("submit")]]);
    expect(refused).toEqual([expect.stringMatching(/base must be a tree/), expect.stringMatching(/base must be a tree/)]);
    expect(await turn(impl, [[read("a.txt")]])).toEqual([BASE["a.txt"]]);
  }));

  it("refuses queues not of the running execution, including an imitation", () => withCommands(async (impl, id) => {
    const refused: string[] = [];
    runCode(impl, id, {
      command: async (repo, replicator, queue) => {
        const {tree} = await replicator.snapshot(queue);
        const imitation = new (class extends RpcTarget {
          // As the real queue's claim would, if it could reach the overseer's map.
          async claimExecution() {}
        })();
        for (const other of [
          await queueFor(impl, crypto.randomUUID(), 2),
          await impl.openGatekeeperSession(7, {startSession: (q: unknown) => q} as never, {from: "user"}) as Queue,
          imitation,
        ]) {
          refused.push(await replicator.snapshot(other).then(() => "", (error: Error) => error.message));
          const command = await commandResult(impl, tree, {"b.txt": "x\n"});
          refused.push(await replicator.submit(other, tree, command.tree, command.pack()).then(() => "", (error: Error) => error.message));
        }
        return "ran";
      },
    });
    expect(await turn(impl, [[execute("command")]])).toEqual(["ran"]);
    expect(refused).toHaveLength(6);
    for (const message of refused) expect(message).toMatch("only while the agent's code runs in its chat");
    expect(await turn(impl, [[read("b.txt")]])).toEqual([BASE["b.txt"]]);
  }));

  it("keeps everyone's edits across parallel submissions and a write during one", () => withCommands(async (impl, id) => {
    runCode(impl, id, {
      command: async (repo, replicator, queue) => {
        const [first, second] = [await replicator.snapshot(queue), await replicator.snapshot(queue)];
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
        await Promise.all([replicator.submit(queue, first.tree, one.tree, one.pack()), replicator.submit(queue, second.tree, two.tree, two.pack())]);
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
      command: async (repo, replicator, queue) => {
        const snapshots = [await replicator.snapshot(queue), await replicator.snapshot(queue), await replicator.snapshot(queue)];
        const from = snapshots[0].tree;
        const results = [
          await commandResult(impl, from, {"dir/c.txt": {mode: "100755", text: "sea\n"}}, true),
          await commandResult(impl, from, {"b.txt": null, "b.txt/inner": "in\n"}, true),
          await commandResult(impl, from, {"dir/c.txt": "sea\nedited\n"}, true),
        ];
        for (const [i, {tree, pack}] of results.entries()) result = (await replicator.submit(queue, snapshots[i].tree, tree, pack())).tree;
        return "ran";
      },
    });
    expect(await turn(impl, [[execute("command")]])).toEqual(["ran"]);
    expect(await treeFiles(impl, result)).toEqual(
      {"a.txt": BASE["a.txt"], "b.txt/inner": "in\n", "dir/c.txt": "sea\nedited\n"});
    const dir = parseGitTree(impl.gitCache.readLocalObject(result)!.payload).find(entry => entry.name === "dir")!;
    expect(parseGitTree(impl.gitCache.readLocalObject(dir.oid)!.payload)[0].mode).toBe("100755");
  }));

  it.each([
    ["writeBytes", (repo: Binding) => repo.writeBytes("b.txt", new Blob(["bytes"]).stream())],
    ["writeFile", (repo: Binding) => repo.writeFile("b.txt", "written\n")],
    ["deleteFile", (repo: Binding) => repo.deleteFile("b.txt")],
  ] as const)("checks a %s again when a submission re-roots the worktree during it", (_, write) => withCommands(async (impl, id) => {
    let refusal!: string;
    runCode(impl, id, {
      command: async (repo, replicator, queue) => {
        const snapshot = await replicator.snapshot(queue);
        const {tree, pack} = await commandResult(impl, snapshot.tree, {"b.txt": null, "b.txt/inner": "in\n"}, true);
        // The command's result arrives once the write has checked its path against the old base.
        const check = impl.gitCache.assertWorktreePathWritable.bind(impl.gitCache);
        let submitted = false;
        impl.gitCache.assertWorktreePathWritable = async (...args) => {
          await check(...args);
          if (!submitted) { submitted = true; await replicator.submit(queue, snapshot.tree, tree, pack()); }
        };
        refusal = await write(repo).then(() => "", (error: Error) => error.message);
        return "ran";
      },
    });
    expect(await turn(impl, [[execute("command")]])).toEqual(["ran"]);
    expect(refusal).toBe("b.txt is a directory");
    expect(await turn(impl, [[read("b.txt/inner")]])).toEqual(["in\n"]);
  }));

  it("keeps a mode-only change against a deletion, as a conflict", () => withCommands(async (impl, id) => {
    let result!: string;
    runCode(impl, id, {
      command: async (repo, replicator, queue) => {
        const snapshots = await Promise.all([1, 2, 3, 4].map(() => replicator.snapshot(queue)));
        const from = snapshots[0].tree;
        // b.txt: the command deletes what the workspace made executable; dir/c.txt the reverse.
        const results = [
          await commandResult(impl, from, {"b.txt": {mode: "100755", text: "bee\n"}}, true),
          await commandResult(impl, from, {"b.txt": null}, true),
          await commandResult(impl, from, {"dir/c.txt": null}, true),
          await commandResult(impl, from, {"dir/c.txt": {mode: "100755", text: "sea\n"}}, true),
        ];
        for (const [i, {tree, pack}] of results.entries()) result = (await replicator.submit(queue, snapshots[i].tree, tree, pack())).tree;
        return "ran";
      },
    });
    const [output] = await turn(impl, [[execute("command")]]);
    expect(await treeFiles(impl, result)).toEqual({"a.txt": BASE["a.txt"], "b.txt": "bee\n", "dir/c.txt": "sea\n"});
    const modes = async (tree: string, prefix = ""): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const entry of parseGitTree(impl.gitCache.readLocalObject(tree)!.payload)) {
        if (entry.mode === "40000") Object.assign(out, await modes(entry.oid, `${prefix}${entry.name}/`));
        else out[prefix + entry.name] = entry.mode;
      }
      return out;
    };
    expect(await modes(result)).toEqual({"a.txt": "100644", "b.txt": "100755", "dir/c.txt": "100755"});
    expect(output).toMatch(/conflicts in: [^\n]*b\.txt/);
    expect(output).toMatch(/conflicts in: [^\n]*dir\/c\.txt/);
  }));

  it("refuses objects outside its pack and the snapshot, though the workspace holds them", () => withCommands(async (impl, id) => {
    const refused: unknown[] = [];
    let moved!: string;
    runCode(impl, id, {
      command: async (repo, replicator, queue) => {
        const snapshot = await replicator.snapshot(queue);
        const secret = (await impl.gitCache.writeBlob(enc("secret\n"))).oid;
        const submit = (tree: string, objects: PackableObject[]) => replicator.submit(queue, snapshot.tree, tree,
          buildPackStream(objects.length, (async function* () { yield* objects; })())).catch((error: Error) => error.message);
        const object = (oid: string) => impl.gitCache.readLocalObject(oid)!;
        // Another worktree's tree, by its ID alone.
        const other = await impl.gitCache.writeChangedTreeOf(snapshot.tree, new Map([["s.txt", "secret\n"]]));
        refused.push(await submit(other, []));
        // A tree in the pack naming a blob the workspace holds.
        refused.push(await submit(other, [object(other)]));
        // A thin pack, with a delta against that blob.
        const delta = deflateSync(new Uint8Array([7, 6, 0x90, 6]));
        const body = concatBytes([enc("PACK"), new Uint8Array([0, 0, 0, 2, 0, 0, 0, 1, (7 << 4) | 4]),
          Uint8Array.from(secret.match(/../g)!, byte => parseInt(byte, 16)), delta]);
        const thin = concatBytes([body, new Uint8Array(await crypto.subtle.digest("SHA-1", body))]);
        refused.push(await replicator.submit(queue, snapshot.tree, other, byteStream(thin)).catch((error: Error) => error.message));
        // A file moved within the snapshot needs nothing but the new trees.
        const b = parseGitTree(object(snapshot.tree).payload).find(entry => entry.name === "b.txt")!;
        const tree = await impl.gitCache.writeChangedTreeOf(snapshot.tree,
          new Map<string, {mode: "100644", oid: string} | null>([["b.txt", null], ["moved.txt", {mode: "100644", oid: b.oid}]]));
        moved = (await submit(tree, [object(tree)]) as {tree: string}).tree;
        return "ran";
      },
    });
    expect(await turn(impl, [[execute("command")]])).toEqual(["ran"]);
    expect(refused).toEqual([expect.stringMatching(/neither in its pack nor in its base/),
      expect.stringMatching(/neither in its pack nor in its base/), expect.stringMatching(/delta base .* is unavailable/)]);
    expect(await treeFiles(impl, moved)).toEqual({"a.txt": BASE["a.txt"], "dir/c.txt": "sea\n", "moved.txt": "bee\n"});
  }));

  it("installs nothing if the execution ends during the submission", () => withCommands(async (impl, id, base) => {
    let submitting!: Promise<unknown>;
    let finish!: () => void;
    runCode(impl, id, {
      command: async (repo, replicator, queue) => {
        const snapshot = await replicator.snapshot(queue);
        const command = await commandResult(impl, snapshot.tree, {"b.txt": "late\n"});
        const reader = command.pack().getReader();
        // The code returns once the submission, past its check of the queue, reads the pack.
        const consume = impl.gitCache.consumePackFromGatekeeper.bind(impl.gitCache);
        let reading!: () => void;
        const read = new Promise<void>(resolve => reading = resolve);
        impl.gitCache.consumePackFromGatekeeper = (...args) => { reading(); return consume(...args); };
        submitting = replicator.submit(queue, snapshot.tree, command.tree, new ReadableStream({
          async start(controller) {
            await new Promise<void>(resolve => finish = resolve);
            for (let next = await reader.read(); !next.done; next = await reader.read()) controller.enqueue(next.value);
            controller.close();
          },
        }));
        submitting.catch(() => {});
        await read;
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

  it("refuses an earlier execution's queue", () => withCommands(async (impl, id) => {
    let earlier!: Queue;
    let refused: unknown;
    runCode(impl, id, {
      snapshot: async (repo, replicator, queue) => { earlier = queue; },
      submit: async (repo, replicator, queue) => {
        const {tree} = await replicator.snapshot(queue);
        const command = await commandResult(impl, tree, {"b.txt": "x\n"});
        refused = await replicator.submit(earlier, tree, command.tree, command.pack()).catch((error: Error) => error.message);
      },
    });
    await turn(impl, [[execute("snapshot")], [execute("submit")]]);
    expect(refused).toMatch("only while the agent's code runs in its chat");
    expect(pins(impl)).toEqual([]);
  }));

  it("is saved with its step when the turn is cancelled while the command runs", () => withCommands(async (impl, id) => {
    const abort = new AbortController();
    runCode(impl, id, {
      command: async (repo, replicator, queue) => {
        const snapshot = await replicator.snapshot(queue);
        const command = await commandResult(impl, snapshot.tree, {"b.txt": "cancelled\n"});
        await replicator.submit(queue, snapshot.tree, command.tree, command.pack());
        abort.abort();
        return "ran";
      },
    });
    await turn(impl, [[execute("command")]], abort.signal).catch(() => {});
    // The completed call's record and its effects land together, as for any tool's edits.
    expect(pins(impl)).toHaveLength(1);
    expect(await turn(impl, [[read("b.txt")]])).toEqual(["cancelled\n"]);
  }));

  // (The queue is lost with the restart too: it was an in-memory stub into the object that
  // restarted.)
  it("is lost if the workspace restarts before the step's barrier", async () => {
    const name = crypto.randomUUID();
    await withCommands(async (impl, id) => {
      let submitted!: () => void;
      const reached = new Promise<void>(resolve => submitted = resolve);
      runCode(impl, id, {
        command: async (repo, replicator, queue) => {
          const snapshot = await replicator.snapshot(queue);
          const result = await commandResult(impl, snapshot.tree, {"b.txt": "crashed\n"});
          await replicator.submit(queue, snapshot.tree, result.tree, result.pack());
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
      command: async (repo, replicator, queue) => {
        const snapshot = await replicator.snapshot(queue);
        await repo.writeFile("b.txt", "edited\n");
        const command = await commandResult(impl, snapshot.tree, {"b.txt": null, "b.txt/inner": "x\n"});
        refused = await replicator.submit(queue, snapshot.tree, command.tree, command.pack()).catch((error: Error) => error.message);
      },
    });
    await turn(impl, [[execute("command")]]);
    expect(refused).toMatch(/both a file and a directory/);
    expect(await turn(impl, [[read("b.txt")]])).toEqual(["edited\n"]);
  }));

  it("refuses symlinks, .git entries and their aliases, and missing objects", () => withCommands(async (impl, id) => {
    const refused: unknown[] = [];
    runCode(impl, id, {
      command: async (repo, replicator, queue) => {
        const snapshot = await replicator.snapshot(queue);
        for (const command of [await commandResult(impl, snapshot.tree, {"link": {mode: "120000", text: "a.txt"}}),
          packedResult(impl, snapshot.tree, treeWithFile(impl, snapshot.tree, ".git/config", "x\n")),
          packedResult(impl, snapshot.tree, treeWithFile(impl, snapshot.tree, "sub/.GIT", "x\n")),
          // Names that HFS+ (which ignores some invisible characters) or NTFS take for `.git`.
          ...[".git\u200c/config", "git~1/config", ".git. /config"].map(path =>
            packedResult(impl, snapshot.tree, treeWithFile(impl, snapshot.tree, path, "x\n")))]) {
          refused.push(await replicator.submit(queue, snapshot.tree, command.tree, command.pack()).catch((error: Error) => error.message));
        }
        const command = await commandResult(impl, snapshot.tree, {"b.txt": "lost\n"});
        refused.push(await replicator.submit(queue, snapshot.tree, command.tree, buildPackStream(0, (async function* () {})()))
          .catch((error: Error) => error.message));
        // A tree no Git would write, with an entry name that hides a path.
        const blob = {type: "blob" as const, payload: enc("x\n")};
        const blobId = await gitObjectOid("blob", blob.payload);
        const tree = {type: "tree" as const, payload: concatBytes([enc("100644 sub/.git/config\0"),
          Uint8Array.from(blobId.match(/../g)!, byte => parseInt(byte, 16))])};
        refused.push(await replicator.submit(queue, snapshot.tree, await gitObjectOid("tree", tree.payload),
          buildPackStream(2, (async function* () { yield blob; yield tree; })())).catch((error: Error) => error.message));
      },
    });
    await turn(impl, [[execute("command")]]);
    expect(refused).toEqual([expect.stringMatching(/symlinks and submodules/), expect.stringMatching(/\.git entry/),
      expect.stringMatching(/\.git entry/), ...[".git\u200c", "git~1", ".git. "].map(name =>
        expect.stringContaining(`name Git reserves for one (${JSON.stringify(name)})`)), expect.stringMatching(/neither in its pack nor in its base/),
      expect.stringMatching(/is malformed/)]);
    expect(pins(impl)).toEqual([]);
  }));
});

// ---------------------------------------------------------------------------------------------
// Gatekeeper session lifetime: requireLive(), watchSession() and getExecutionId(), through the
// same agent turns as the commands above.

type Session = {
  requireLive(): Promise<void>;
  watchSession(watcher: RpcTarget): Promise<Disposable>;
  getExecutionId(): Promise<string | undefined>;
} & Disposable;

// A gatekeeper's watcher: `released` settles once the workspace lets go of it.
class Watcher extends RpcTarget {
  released: Promise<void>;
  #release!: () => void;
  constructor() {
    super();
    this.released = new Promise(resolve => this.#release = resolve);
  }
  [Symbol.dispose]() { this.#release(); }
}
// Whether `watcher` is released within a few turns of the event loop.
const releasedSoon = (watcher: Watcher) => Promise.race([watcher.released.then(() => true),
  new Promise<boolean>(resolve => setTimeout(() => resolve(false), 200))]);
const failure = (promise: Promise<unknown>) => promise.then(() => "", (error: Error) => error.message);

// The connection that queueFor()'s sessions belong to.
function connect(impl: Impl) {
  impl.storage.gatekeepers.put({id: 7, class: impl.ctx.exports.ReplicaGitSource({}),
    creationSpec: {type: "gatekeeper", vendorId: "github", typeUrlPattern: "https://github.com/*/*",
      resourceUrl: "https://github.com/fixture/session"}});
}
// The queue as a gatekeeper holds it: a stub, so what it is passed crosses RPC.
const asStub = (queue: Queue) => new RpcStub(queue as RpcTarget) as unknown as Session;

describe("gatekeeper session lifetime", () => {
  it("lives as long as the agent's code execution that opened it", () => withCommands(async (impl, id) => {
    connect(impl);
    const watcher = new Watcher();
    let session!: Session, during!: unknown[];
    runCode(impl, id, {
      command: async (repo, replicator, queue, execution) => {
        session = asStub(queue);
        await session.watchSession(watcher);
        during = [await failure(session.requireLive()), await session.getExecutionId() === execution,
          await releasedSoon(watcher)];
      },
    });
    await turn(impl, [[execute("command")]]);
    expect(during).toEqual(["", true, false]);
    expect(await releasedSoon(watcher)).toBe(true);
    expect(await failure(session.requireLive())).toMatch("code execution this session belongs to has ended");
    // Watching a session that is over releases the watcher at once.
    const late = new Watcher();
    await session.watchSession(late);
    expect(await releasedSoon(late)).toBe(true);
  }));

  it("ends when the user stops the turn, while the execution's code still runs", () => withCommands(async (impl, id) => {
    connect(impl);
    const abort = new AbortController();
    const watcher = new Watcher();
    let observed!: unknown[];
    runCode(impl, id, {
      command: async (repo, replicator, queue) => {
        const session = asStub(queue);
        await session.watchSession(watcher);
        const before = await releasedSoon(watcher);
        abort.abort();
        // The code can't be interrupted; it is still running here, but its session is over.
        observed = [before, await releasedSoon(watcher), await failure(session.requireLive())];
        return "ran";
      },
    });
    await turn(impl, [[execute("command")]], abort.signal).catch(() => {});
    expect(observed).toEqual([false, true, expect.stringContaining("stopped the agent turn")]);
  }));

  it("stops watching when the handle is disposed, or the gatekeeper releases the queue", () => withCommands(async (impl, id) => {
    connect(impl);
    const [unwatched, kept] = [new Watcher(), new Watcher()];
    let released!: boolean[];
    runCode(impl, id, {
      command: async (repo, replicator, queue) => {
        const session = asStub(queue);
        (await session.watchSession(unwatched))[Symbol.dispose]();
        const first = await releasedSoon(unwatched);
        await session.watchSession(kept);
        const before = await releasedSoon(kept);
        session[Symbol.dispose]();
        released = [first, before, await releasedSoon(kept)];
      },
    });
    await turn(impl, [[execute("command")]]);
    expect(released).toEqual([true, false, true]);
  }));

  it("ties an agent spawner's session to its execution, like any other", () => withCommands(async (impl, id) => {
    impl.storage.gatekeepers.put({id: 8, class: impl.ctx.exports.ReplicaGitSource({}),
      creationSpec: {type: "agentSpawner", config: {displayName: "Spawner", modelId: null}}});
    let session!: Session, matched!: boolean;
    runCode(impl, id, {
      command: async (repo, replicator, queue, execution) => {
        session = asStub(await impl.openGatekeeperSession(
          8, {startSession: (q: unknown) => q} as never, {from: "agent", chatId: 1}, execution) as Queue);
        matched = await session.getExecutionId() === execution;
      },
    });
    await turn(impl, [[execute("command")]]);
    expect(matched).toBe(true);
    expect(await failure(session.requireLive())).toMatch("code execution this session belongs to has ended");
  }));

  it("ends a session with no execution when its connection is removed", () => withCommands(async impl => {
    connect(impl);
    const session = asStub(await impl.openGatekeeperSession(
      7, {startSession: (queue: unknown) => queue} as never, {from: "user"}) as Queue);
    const watcher = new Watcher();
    await session.watchSession(watcher);
    expect([await failure(session.requireLive()), await session.getExecutionId(), await releasedSoon(watcher)])
      .toEqual(["", undefined, false]);
    impl.removeGatekeeper(7);
    expect(await releasedSoon(watcher)).toBe(true);
    expect(await failure(session.requireLive())).toMatch("connection has been removed");
  }));
});
