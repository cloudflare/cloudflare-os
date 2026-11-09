import {describe, expect, it} from "vitest";
import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import type {OverseerDurableObject} from "./test-worker";
import {buildGitFetchRequest, demuxGitFetchResponse, encodePktLine, FLUSH_PKT, DELIM_PKT}
  from "@gadgets/gatekeeper-kit/git-transport";
import {abortAllDurableObjects} from "cloudflare:test";
import {createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type TranscriptContext} from "@earendil-works/pi-ai";
import {buildPackStream, concatBytes, decodePackStream, gitObjectOid, parseGitTree, type PackableObject}
  from "../src/git-codec";
import {runAgent} from "../src/agent";

const testEnv = env as Cloudflare.Env & {
  TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
};
type Impl = OverseerDurableObject["impl"];
const author = {type: "agent" as const, id: "test", name: "Test"};
async function setup(impl: Impl) {
  impl.storage.chatMeta.put({id: 1, title: "Mounted worktree", started: new Date(), lastActive: new Date()});
  const commit = await impl.gitStore.writeFilesAsCommit(new Map([
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
// The Worktree stub a gatekeeper keeps, minted for an execution that has since ended.
const mounted = (impl: Impl, worktreeId: number) =>
  impl.ctx.restore({type: "worktree", chatId: 1, worktreeId, executionId: "ended"});
// Fetch `want` through the stub, as native Git would, and list the pack's objects.
async function transfer(worktree: {gitPull(request: Request): Promise<Response>}, want: string, haves?: string[]) {
  const response = await worktree.gitPull(new Request("https://git.invalid/git-upload-pack", {
    method: "POST", headers: {"git-protocol": "version=2", "content-type": "application/x-git-upload-pack-request"},
    body: buildGitFetchRequest([want], {type: "commit", commitHistory: {kind: "full"}, haves}),
  }));
  const objects = [];
  const bases = new Map<string, PackableObject>();
  for await (const object of decodePackStream(demuxGitFetchResponse(response.body!),
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
const fetchRequest = (want: string, extra = ["deepen 1"]) => new Request("https://git.invalid/git-upload-pack", {
  method: "POST", headers: {"git-protocol": "version=2", "content-type": "application/x-git-upload-pack-request"},
  body: new Blob([encodePktLine("command=fetch"), DELIM_PKT, encodePktLine(`want ${want}`),
    ...extra.map(encodePktLine), encodePktLine("done"), FLUSH_PKT]),
});
// Read a response up to the start of its pack.
async function preamble(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let text = "";
  while (!text.includes("packfile\n")) text += new TextDecoder().decode((await reader.read()).value);
  return text;
}
// Commit `files` on top of the worktree's head, as the agent's commit() does.
async function commitOnHead(impl: Impl, id: number, files: [string, string][]) {
  const previousHead = impl.getWorktreeRecord(id).headCommit;
  const commit = await impl.gitStore.writeChangedFilesAsCommit(new Map(files), {
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
  const merged = await impl.gitStore.writeFilesAsCommit(new Map([["a.txt", "abc"], ["other.txt", "other"]]),
    {parents: [], author: {name: "Test", email: "test@example.com"}, message: "Other", timestamp: new Date(0)});
  const sources = await connectGitSource(impl, merged, ids);
  const commit = await impl.gitStore.writeChangedFilesAsCommit(new Map([["other.txt", "other"]]), {
    treeBase: previousHead, parents: [previousHead, merged], author: {name: "Test", email: "test@example.com"},
    message: "Merge", timestamp: new Date(),
  });
  await impl.commitAgentStep(1, author, [], {changes: [], createdGadgets: [], createdWorktrees: [],
    addedBindings: [], worktreeCommits: [{worktreeId: id, commit, previousHead}], blueprintMerges: []});
  return {head: commit, merged, sources};
}
// A fetch left running, which the test ends by deleting the worktree.
const started = (fetching: Promise<Response>) => fetching.then(response => response.body?.cancel(), () => {});

async function until(predicate: () => Promise<boolean>) {
  for (let n = 0; n < 1000; ++n) {
    if (await predicate()) return;
    await scheduler.wait(1);
  }
  throw new Error("Test barrier did not arrive");
}

describe("mounted worktree Git fetches", () => {
  it("serves the worktree's Git head after its execution ended, but not its file methods", () => within(async (impl, f) => {
    await step(impl, f.tree.id, "a.txt", "committed");
    const head = await commitOnHead(impl, f.tree.id, [["a.txt", "committed"]]);
    await step(impl, f.tree.id, "a.txt", "committed + pending");
    using worktree = await mounted(impl, f.tree.id);
    const refs = await worktree.gitPull(new Request("https://git.invalid/git-upload-pack", {
      method: "POST", headers: {"git-protocol": "version=2", "content-type": "application/x-git-upload-pack-request"}, body: new Blob([
        encodePktLine("command=ls-refs"), DELIM_PKT, encodePktLine("symrefs"), FLUSH_PKT,
      ]),
    }));
    expect(new TextDecoder().decode(await refs.arrayBuffer())).toContain(`${head} HEAD`);
    const objects = await transfer(worktree, head);
    expect(objects).toContainEqual({oid: head, type: "commit", binary: false});
    expect(objects).toContainEqual({oid: f.commit, type: "commit", binary: false});
    expect(objects).toContainEqual(expect.objectContaining({type: "blob", binary: true}));
    expect(await worktree.readFile("a.txt").then(() => "", (error: Error) => error.message))
      .toMatch(/no longer live/);
    expect(await text(impl, f.tree.id)).toBe("committed + pending");
  }));

  it("sends only what a fetch of a new head lacks", () => within(async (impl, f) => {
    const head = await commitOnHead(impl, f.tree.id, [["a.txt", "moved"]]);
    using worktree = await mounted(impl, f.tree.id);
    const objects = await transfer(worktree, head, [f.commit]);
    expect(objects.map(object => object.type).toSorted()).toEqual(["blob", "commit", "tree"]);
    expect(objects).toContainEqual({oid: head, type: "commit", binary: false});
  }));

  it("proxies a fetch of an ancestor once its connection confirms it, until the connection is removed", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    const response = await impl.worktreeGitPull(1, f.tree.id, fetchRequest(ANCESTOR));
    const reader = response.body!.getReader();
    expect(await preamble(reader)).toContain(`shallow ${ANCESTOR}\n`);
    const [check, forwarded] = await source.requests();
    expect(check).toContain(`want ${ANCESTOR}\n`);
    expect(check).toContain(`have ${f.commit}\n`);
    expect(forwarded).toContain(`want ${ANCESTOR}\n`);
    expect(forwarded).toContain("deepen 1\n");
    const next = reader.read().then(result => result.done, () => true);
    impl.removeGatekeeper(40);
    expect(await next).toBe(true);
    await reader.cancel().catch(() => {});
  }));

  it("refuses a commit outside the worktree's history without forwarding the fetch", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    await source.setUnrelated(ANCESTOR);
    await expect(impl.worktreeGitPull(1, f.tree.id, fetchRequest(ANCESTOR)))
      .rejects.toThrow("Only commits in the worktree's history can be fetched.");
    expect(await source.requests()).toHaveLength(1);
  }));

  it("asks the next connection when one doesn't find the commit in the history it knows", () => within(async (impl, f) => {
    const [first, second] = await connectGitSource(impl, f.commit, [40, 41]);
    await first.setUnrelated(ANCESTOR);
    const response = await impl.worktreeGitPull(1, f.tree.id, fetchRequest(ANCESTOR));
    await response.body!.cancel();
    expect(await first.requests()).toHaveLength(1);
    expect(await second.requests()).toHaveLength(2);
  }));

  it("refuses fetch arguments it doesn't understand, such as fetching by ref name", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    await expect(impl.worktreeGitPull(1, f.tree.id, fetchRequest(ANCESTOR, ["want-ref refs/heads/main"])))
      .rejects.toThrow("Unsupported Git fetch argument: want-ref");
    await expect(impl.worktreeGitPull(1, f.tree.id, fetchRequest(ANCESTOR, ["deepen-not main"])))
      .rejects.toThrow("Unsupported Git fetch argument: deepen-not");
    expect(await source.requests()).toHaveLength(0);
  }));

  it("proxies a deepen of the head the client already has, without a history check", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    const response = await impl.worktreeGitPull(1, f.tree.id, fetchRequest(f.commit,
      [`have ${f.commit}`, `shallow ${f.commit}`, "deepen 3", "deepen-relative"]));
    const reader = response.body!.getReader();
    await preamble(reader);
    await reader.cancel();
    const [forwarded, ...rest] = await source.requests();
    expect(rest).toEqual([]);
    for (const line of [`want ${f.commit}`, `shallow ${f.commit}`, "deepen 3", "deepen-relative", `have ${f.commit}`])
      expect(forwarded).toContain(`${line}\n`);
  }));

  it("proxies a deeper clone of a worktree still at its remote base", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    const response = await impl.worktreeGitPull(1, f.tree.id, fetchRequest(f.commit, ["deepen 2"]));
    await preamble(response.body!.getReader());
    const [forwarded, ...rest] = await source.requests();
    expect(rest).toEqual([]);
    expect(forwarded).toContain(`want ${f.commit}\n`);
    expect(forwarded).toContain("deepen 2\n");
  }));

  it("proxies a fresh fetch of the base together with an ancestor", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    const response = await impl.worktreeGitPull(1, f.tree.id, fetchRequest(f.commit, [`want ${ANCESTOR}`, "deepen 1"]));
    await preamble(response.body!.getReader());
    const forwarded = (await source.requests()).at(-1)!;
    expect(forwarded).toContain(`want ${f.commit}\n`);
    expect(forwarded).toContain(`want ${ANCESTOR}\n`);
  }));

  it("deepens past the base after a descendant was pushed", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    const head = await commitOnHead(impl, f.tree.id, [["a.txt", "pushed"]]);
    impl.storage.gitObjectMetadata.put({oid: head, type: "commit", onRemote: [40], pullableFrom: [], pendingPush: []});
    const response = await impl.worktreeGitPull(1, f.tree.id, fetchRequest(head,
      [`have ${head}`, `shallow ${f.commit}`, "deepen 1", "deepen-relative"]));
    await preamble(response.body!.getReader());
    // From the pushed commit, now the history's boundary.
    const [forwarded, ...rest] = await source.requests();
    expect(rest).toEqual([]);
    for (const line of [`want ${head}`, `have ${head}`, `shallow ${f.commit}`, "deepen-relative"])
      expect(forwarded).toContain(`${line}\n`);
  }));

  it("streams every boundary commit from one connection that has them all, in one request", () => within(async (impl, f) => {
    const [one, both] = await connectGitSource(impl, f.commit, [40, 41]);
    const {head, merged} = await mergeOnHead(impl, f.tree.id, [41]);
    const fetching = started(impl.worktreeGitPull(1, f.tree.id, fetchRequest(head, [])));
    await until(async () => (await both.requests()).length === 1);
    const [forwarded] = await both.requests();
    for (const line of [`want ${f.commit}`, `want ${merged}`, "deepen 1"]) expect(forwarded).toContain(`${line}\n`);
    expect(forwarded).not.toContain(`want ${head}`);
    expect(await one.requests()).toEqual([]);
    impl.storage.gadgets.delete(f.tree.id);
    await fetching;
  }));

  it("refuses a clone when no one connection has every boundary commit", () => within(async (impl, f) => {
    const [first] = await connectGitSource(impl, f.commit, [40]);
    const {head, sources: [second]} = await mergeOnHead(impl, f.tree.id, [41]);
    await expect(impl.worktreeGitPull(1, f.tree.id, fetchRequest(head, [])))
      .rejects.toThrow("none of them has all of it");
    expect(await first.requests()).toEqual([]);
    expect(await second.requests()).toEqual([]);
  }));

  it("clones a worktree still at its remote base shallow, at depth 1", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    const fetching = started(impl.worktreeGitPull(1, f.tree.id, fetchRequest(f.commit, [])));
    await until(async () => (await source.requests()).length === 1);
    const [forwarded] = await source.requests();
    expect(forwarded).toContain(`want ${f.commit}\n`);
    expect(forwarded).toContain("deepen 1\n");
    impl.storage.gadgets.delete(f.tree.id);
    await fetching;
  }));

  it("gives a clone deeper than the boundary less history", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    const head = await commitOnHead(impl, f.tree.id, [["a.txt", "moved"]]);
    const fetching = started(impl.worktreeGitPull(1, f.tree.id, fetchRequest(head, ["deepen 5"])));
    await until(async () => (await source.requests()).length === 1);
    const [forwarded] = await source.requests();
    expect(forwarded).toContain(`want ${f.commit}\n`);
    expect(forwarded).toContain("deepen 1\n");
    impl.storage.gadgets.delete(f.tree.id);
    await fetching;
  }));

  it("cancels a pull stalled before its pack when the worktree is deleted", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    await source.setStalled();
    const fetching = impl.worktreeGitPull(1, f.tree.id, fetchRequest(ANCESTOR));
    fetching.catch(() => {});
    await until(async () => (await source.requests()).length === 2);
    await scheduler.wait(20);
    impl.storage.gadgets.delete(f.tree.id);
    const error = await fetching.then(() => undefined, (error: Error) => error);
    expect((error?.cause as Error | undefined)?.message).toMatch(/No such worktree/);
  }));

  it("refuses a fetch needing both new workspace commits and remote history", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    const head = await commitOnHead(impl, f.tree.id, [["a.txt", "moved"]]);
    await expect(impl.worktreeGitPull(1, f.tree.id, fetchRequest(head, [`have ${f.commit}`, `shallow ${f.commit}`, "deepen 5"])))
      .rejects.toThrow("Fetch the worktree's head first, then fetch again.");
    await expect(impl.worktreeGitPull(1, f.tree.id, fetchRequest(head, [`want ${ANCESTOR}`, `have ${f.commit}`])))
      .rejects.toThrow("Fetch the worktree's head first, then fetch again.");
    expect(await source.requests()).toHaveLength(0);
  }));

  it("refuses commits the workspace doesn't have when no connection serves the history", () => within(async (impl, f) => {
    await expect(impl.worktreeGitPull(1, f.tree.id, fetchRequest(ANCESTOR)))
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
// Worktree binding as the loopback resolves it, as a gatekeeper the agent's code passed it to
// would.

type Command = Awaited<ReturnType<Endpoint["snapshot"]>>["command"];
type Endpoint = {
  snapshot(): Promise<{tree: string; head: string; command: {submit(tree: string, pack: ReadableStream<Uint8Array>): Promise<{tree: string; head: string}>}}>;
  gitPull(request: Request): Promise<Response>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
};
type Code = (repo: Endpoint, executionId: string) => Promise<string | void>;
const BASE = {"a.txt": "one\ntwo\nthree\n", "b.txt": "bee\n", "dir/c.txt": "sea\n"};
const enc = (value: string) => new TextEncoder().encode(value);

async function withCommands(test: (impl: Impl, id: number, base: string) => Promise<void>, name?: string) {
  await runInDurableObject(testEnv.TEST_OVERSEER.getByName(name ?? crypto.randomUUID()), async instance => {
    const impl = instance.impl;
    impl.storage.chatMeta.put({id: 1, title: "Chat", started: new Date(0), lastActive: new Date(0)});
    const base = await impl.gitStore.writeFilesAsCommit(new Map(Object.entries(BASE)),
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
        output = await code[worker.modules["agent.js"]](repo, execution);
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
  let tree: string = await impl.gitStore.writeChangedTreeOf(from, new Map(deleted.map(path => [path, null])));
  const changes = new Map<string, unknown>();
  for (const [path, edit] of Object.entries(edits)) {
    if (edit !== null) changes.set(path, typeof edit === "string" ? edit
      : {mode: edit.mode, oid: (await impl.gitStore.writeBlob(enc(edit.text))).oid});
  }
  tree = await impl.gitStore.writeChangedTreeOf(tree, changes as never);
  const old = reachable(impl, from);
  const objects = [...reachable(impl, tree)].filter(oid => !old.has(oid))
    .map(oid => ({oid, ...impl.gitCache.readLocalObject(oid)!}));
  if (!keep) for (const {oid} of objects) impl.storage.gitObjects.delete(oid);
  return {tree, pack: () => buildPackStream(objects.length, (async function* () { yield* objects; })())};
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
    let snapshot!: Awaited<ReturnType<Endpoint["snapshot"]>>, result!: string, returned: unknown;
    runCode(impl, id, {
      command: async repo => {
        await repo.writeFile("a.txt", "one\ntwo\nthree\nbuffered\n");
        snapshot = await repo.snapshot();
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
    expect(await impl.gitStore.commitTree(pin.baseCommit)).toBe(result);
    expect((await impl.gitStore.readCommitObject(pin.baseCommit)).parent).toEqual([base]);
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
      command: async repo => {
        await repo.writeFile("b.txt", "edited\n");
        tree = (await repo.snapshot()).tree;
        during = await transfer(repo, tree, [base]);
      },
    });
    await turn(impl, [[execute("command")]]);
    // Only what the client's commit lacks: the new root tree and blob.
    expect(during.map(object => object.type).toSorted()).toEqual(["blob", "tree"]);
    expect(during).toContainEqual({oid: tree, type: "tree", binary: true});
    using worktree = await mounted(impl, id);
    await expect(transfer(worktree, tree, [base])).rejects.toThrow();
  }));

  it("keeps working through a stub an earlier execution received, but only its replica methods", () => withCommands(async (impl, id) => {
    let kept!: Endpoint, first!: string;
    const outputs: string[] = [];
    runCode(impl, id, {
      mount: async (repo, execution) => { kept = repo; first = execution; },
      command: async () => {
        // As a gatekeeper restoring the binding it stored would: every call resolves anew.
        const restored = await impl.startGatekeeperSession({type: "worktree", id, executionId: first}, {from: "agent", chatId: 1});
        for (const repo of [kept, restored]) {
          const snapshot = await repo.snapshot();
          const command = await commandResult(impl, snapshot.tree, {"b.txt": `${outputs.length}\n`});
          outputs.push((await snapshot.command.submit(command.tree, command.pack())).tree);
          outputs.push(await repo.readFile("b.txt").catch((error: Error) => error.message));
        }
      },
    });
    await turn(impl, [[execute("mount")], [execute("command")]]);
    expect(outputs[1]).toMatch(/no longer live/);
    expect(outputs[3]).toMatch(/no longer live/);
    expect(await turn(impl, [[read("b.txt")]])).toEqual(["2\n"]);
    expect(await transfer(kept, impl.getWorktreeRecord(id).headCommit)).not.toEqual([]);
  }));

  it("returns the first result on a retry, even after a conflicting merge, and refuses another", () => withCommands(async (impl, id) => {
    let results: unknown[] = [];
    runCode(impl, id, {
      command: async repo => {
        const snapshot = await repo.snapshot();
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
      command: async repo => {
        const [first, second] = [await repo.snapshot(), await repo.snapshot()];
        expect(second.tree).toBe(first.tree);
        const one = await commandResult(impl, first.tree, {"b.txt": "bee\none\n"}, true);
        const two = await commandResult(impl, first.tree, {"a.txt": "one\ntwo\nthree\ntwo\n"}, true);
        // The agent's code writes while the first submission is writing its commit.
        const writeCommit = impl.gitStore.writeCommitForTree.bind(impl.gitStore);
        let wrote = false;
        impl.gitStore.writeCommitForTree = async (...args) => {
          if (!wrote) { wrote = true; await repo.writeFile("dir/c.txt", "written\n"); }
          return writeCommit(...args);
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
      command: async repo => {
        const snapshots = [await repo.snapshot(), await repo.snapshot(), await repo.snapshot()];
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
      command: async repo => {
        const snapshot = await repo.snapshot();
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
      snapshot: async repo => { earlier = (await repo.snapshot()).command; },
      submit: async repo => {
        const command = await commandResult(impl, (await repo.snapshot()).tree, {"b.txt": "x\n"});
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
      command: async repo => {
        const snapshot = await repo.snapshot();
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
        command: async repo => {
          const snapshot = await repo.snapshot();
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
      command: async repo => {
        const snapshot = await repo.snapshot();
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
      command: async repo => {
        const snapshot = await repo.snapshot();
        for (const edits of [{"link": {mode: "120000", text: "a.txt"}}, {".git/config": "x\n"}, {"sub/.GIT": "x\n"}]) {
          const command = await commandResult(impl, snapshot.tree, edits);
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
