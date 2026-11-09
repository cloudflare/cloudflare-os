import {describe, expect, it} from "vitest";
import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import type {OverseerDurableObject} from "./test-worker";
import {buildGitFetchRequest, demuxGitFetchResponse, encodePktLine, FLUSH_PKT, DELIM_PKT}
  from "@gadgets/gatekeeper-kit/git-transport";
import {decodePackStream, type PackableObject} from "../src/git-codec";

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
      .toBe("Worktree execution ended.");
    expect(await text(impl, f.tree.id)).toBe("committed + pending");
  }));

  it("sends only what a fetch of a new head lacks", () => within(async (impl, f) => {
    const head = await commitOnHead(impl, f.tree.id, [["a.txt", "moved"]]);
    using worktree = await mounted(impl, f.tree.id);
    const objects = await transfer(worktree, head, [f.commit]);
    expect(objects.map(object => object.type).sort()).toEqual(["blob", "commit", "tree"]);
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
    expect((await source.requests()).at(-1)).toContain(`want ${f.commit}\n`);
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
