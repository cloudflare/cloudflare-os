// git-upload-pack.ts coverage: which requests are served, the translation of native Git's fetch
// arguments into a worktree pull's hints, and the response framing, read back with the kit's own
// fetch-response parser, including errors before and during the pack.

import type { GitPullStatus, GitPullTransfer, GitShallowInfo } from "@gadgets/workshop-shared/gatekeeper";
import type { WorktreeGitPullHints } from "@gadgets/workshop-shared/worktree-replica";
import { describe, expect, it } from "vitest";
import { DELIM_PKT, FLUSH_PKT, encodePktLine, openGitFetchResponse } from "../src/git-transport";
import { serveGitUploadPack, type GitUploadPackSource } from "../src/git-upload-pack";

const HEAD = "a".repeat(40);
const HAVE = "b".repeat(40);
const PACK = new TextEncoder().encode("PACK-and-more");

function transferOf(pack: ReadableStream<Uint8Array>, shallow: GitShallowInfo = {shallow: [], unshallow: []},
    status: GitPullStatus = {state: "complete"}): GitPullTransfer {
  return {stream: async () => pack, status: async () => status, shallowInfo: async () => shallow} as GitPullTransfer;
}
const bytes = (...chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({start(controller) {
  for (const chunk of chunks) controller.enqueue(chunk);
  controller.close();
}});

// A source recording each pull, answering with `answer`.
function source(answer: () => Promise<GitPullTransfer> = async () => transferOf(bytes(PACK))) {
  const pulls: {oids: string[]; hints: WorktreeGitPullHints}[] = [];
  const served: GitUploadPackSource = {
    gitHead: async () => HEAD,
    gitPull: async (oids, hints) => { pulls.push({oids, hints}); return answer(); },
  };
  return {served, pulls};
}
const post = (lines: (string | Uint8Array)[]) => new Request("https://git.invalid/git-upload-pack", {
  method: "POST", headers: {"git-protocol": "version=2", "content-type": "application/x-git-upload-pack-request"},
  body: new Blob(lines.map(line => typeof line === "string" ? encodePktLine(line) : line)),
});
const fetch = (args: string[]) => post(["command=fetch", "agent=git/2", DELIM_PKT, ...args, FLUSH_PKT]);
const text = async (response: Response) => new TextDecoder().decode(await response.arrayBuffer());

describe("serveGitUploadPack's request check", () => {
  it("advertises protocol v2 on ref discovery", async () => {
    const response = await serveGitUploadPack(new Request("https://git.invalid/info/refs?service=git-upload-pack", {
      headers: {"git-protocol": "version=2"}}), source().served);
    expect(response.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    expect(await text(response)).toContain("fetch=shallow filter");
  });
  it.each([
    ["GET", "/info/refs?service=git-receive-pack"], ["POST", "/git-receive-pack"],
    ["GET", "/anything"], ["POST", "/git-upload-pack?redirect=elsewhere"],
  ])("refuses %s %s", async (method, path) => {
    const response = await serveGitUploadPack(new Request(`https://git.invalid${path}`, {method,
      headers: {"git-protocol": "version=2", "content-type": "application/x-git-upload-pack-request"},
    }), source().served);
    expect(response.status).toBe(400);
    expect(await text(response)).toMatch(/ref discovery and fetch/);
  });
  it("requires protocol v2", async () => {
    const response = await serveGitUploadPack(new Request("https://git.invalid/info/refs?service=git-upload-pack"),
      source().served);
    expect(response.status).toBe(400);
    expect(await text(response)).toMatch(/version 2/);
  });
});

describe("serveGitUploadPack", () => {
  it("lists the worktree's head as its one branch", async () => {
    const response = await serveGitUploadPack(post(["command=ls-refs", DELIM_PKT, "symrefs", FLUSH_PKT]), source().served);
    const listed = await text(response);
    expect(listed).toContain(`${HEAD} HEAD symref-target:refs/heads/worktree\n`);
    expect(listed).toContain(`${HEAD} refs/heads/worktree\n`);
  });

  it("translates a fetch into a pull, and its result into Git's response", async () => {
    const {served, pulls} = source(async () => transferOf(bytes(PACK.subarray(0, 4), PACK.subarray(4)),
      {shallow: [HAVE], unshallow: []}));
    const response = await serveGitUploadPack(fetch([`want ${HEAD}`, `have ${HAVE}`, `shallow ${HAVE}`,
      "deepen 3", "deepen-relative", "filter blob:limit=100", "ofs-delta", "done"]), served);
    expect(pulls).toEqual([{oids: [HEAD], hints: {haves: [HAVE], shallow: [HAVE],
      commitHistory: {kind: "relative", depth: 3}, filterBlobSize: 100}}]);
    const {pack, shallowInfo} = openGitFetchResponse(response.body!);
    expect(await shallowInfo()).toEqual({shallow: [HAVE], unshallow: []});
    expect(new Uint8Array(await new Response(pack).arrayBuffer())).toEqual(PACK);
  });

  it("reads a gzipped request, as Git sends a long one", async () => {
    const {served, pulls} = source();
    const plain = fetch([`want ${HEAD}`, `have ${HAVE}`, "done"]);
    const response = await serveGitUploadPack(new Request(plain.url, {method: "POST",
      headers: {...Object.fromEntries(plain.headers), "content-encoding": "gzip"},
      body: plain.body!.pipeThrough(new CompressionStream("gzip")), duplex: "half"} as RequestInit), served);
    expect(response.status).toBe(200);
    expect(pulls).toEqual([{oids: [HEAD], hints: {haves: [HAVE], shallow: [], commitHistory: {kind: "full"}}}]);
  });

  it("answers a fetch that hasn't finished negotiating at once", async () => {
    const response = await serveGitUploadPack(fetch([`want ${HEAD}`, `have ${HAVE}`]), source().served);
    expect(await text(response)).toMatch(/^[0-9a-f]{4}acknowledgments\n[0-9a-f]{4}ready\n0001[0-9a-f]{4}packfile\n/);
  });

  it.each([
    [[], {kind: "full"}],
    [["deepen 2"], {kind: "depth", depth: 2}],
    [["deepen-since 1000"], {kind: "since", since: new Date(1_000_000)}],
  ])("maps %j to a history of %j", async (args, commitHistory) => {
    const {served, pulls} = source();
    await serveGitUploadPack(fetch([`want ${HEAD}`, ...args, "done"]), served);
    expect(pulls[0].hints.commitHistory).toEqual(commitHistory);
  });

  it.each([
    [["want-ref refs/heads/main"], "Unsupported Git fetch argument: want-ref"],
    [["deepen-not main"], "Unsupported Git fetch argument: deepen-not"],
    [["filter sparse:oid=x"], "Unsupported Git fetch filter."],
    [["deepen 1", "deepen-since 5"], "Only one Git deepen option is supported."],
    [["deepen-relative"], "deepen-relative requires a depth."],
    [["have not-an-oid"], "Invalid object ID in Git fetch."],
  ])("refuses %j as a remote error, without pulling", async (args, message) => {
    const {served, pulls} = source();
    const response = await serveGitUploadPack(fetch([`want ${HEAD}`, ...args, "done"]), served);
    expect(await text(response)).toContain(`ERR ${message}`);
    expect(pulls).toEqual([]);
  });

  it("sends a pull's refusal to Git as a remote error", async () => {
    const response = await serveGitUploadPack(fetch([`want ${HEAD}`, "done"]),
      source(async () => { throw new Error("Fetch the worktree's head first."); }).served);
    const {pack} = openGitFetchResponse(response.body!);
    await expect(new Response(pack).arrayBuffer()).rejects.toThrow("Fetch the worktree's head first.");
  });

  it.each([["before it is read", 0], ["while a read is stalled", 2]])(
      "releases the pack and the transfer when Git disconnects %s", async (_, reads) => {
    let canceled = false;
    let disposed = 0;
    const stalling = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(PACK); },
      cancel() { canceled = true; },
    });
    const transfer = Object.assign(transferOf(stalling), {[Symbol.dispose]: () => { disposed++; }});
    const response = await serveGitUploadPack(fetch([`want ${HEAD}`, "done"]), source(async () => transfer).served);
    const reader = response.body!.getReader();
    for (let n = 0; n < reads; n++) await reader.read();
    // The next read waits for pack data that never comes.
    if (reads) {
      void reader.read().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await reader.cancel();
    expect(canceled).toBe(true);
    expect(disposed).toBe(1);
  });

  it("ends a pack that fails partway with the producer's error, not the stream's", async () => {
    let fail!: (error: Error) => void;
    const failing = new ReadableStream<Uint8Array>({start(controller) {
      controller.enqueue(PACK);
      fail = error => controller.error(error);
    }});
    const response = await serveGitUploadPack(fetch([`want ${HEAD}`, "done"]), source(async () =>
      transferOf(failing, undefined, {state: "failed", message: "Worktree access ended."})).served);
    const {pack} = openGitFetchResponse(response.body!);
    const reader = pack.getReader();
    expect((await reader.read()).value).toEqual(PACK);
    fail(new Error("Network connection lost."));
    await expect(reader.read()).rejects.toThrow("Worktree access ended.");
  });
});
