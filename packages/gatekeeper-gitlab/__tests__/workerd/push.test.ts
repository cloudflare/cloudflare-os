// The push action on the real gatekeeper Durable Object: queue-time binding of the expected old
// head (stacked pushes compose; non-fast-forward refused; creation exempt), simulated reads over
// queued pushes (branch heads, refs, commits, history, an MR's diff and merge base), apply through
// receive-pack framing with the queue-time CAS and desired-state idempotency, revert by ref
// rollback or deletion, reject cascades, and the gitPull request framing. GitLab is faked at
// fetch; the workspace git cache is a stub the test controls.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitObjectType, GitOid } from "@gadgets/workshop-shared/gatekeeper";
import { FLUSH_PKT, ZERO_OID, emptyPackBytes, encodePktLine, pktText } from "@gadgets/gatekeeper-kit/git-transport";
import * as fx from "../fixtures/gitlab-docs.js";
import { FakeGitLab, json, hooks, projectProps, seedAccount, unwrap } from "./fake-gitlab.js";
import type { ActionPresentation, GatekeeperProps } from "./worker.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const P = "group%2Fsub%2Fproject";
const PROJECT = "group/sub/project";
const BASE = "a".repeat(40);   // the branch head on GitLab
const HEAD1 = "b".repeat(40);  // agent-authored, child of BASE
const HEAD2 = "c".repeat(40);  // agent-authored, child of HEAD1
const OTHER = "d".repeat(40);  // an unrelated head the remote may move to
const TREE1 = "1".repeat(40);
const TREE2 = "2".repeat(40);
const BASE_TREE = "0".repeat(40);
/**
 * Stands in for the overseer-built pack, which the gatekeeper must pass through untouched: bytes
 * no UTF-8 round trip preserves (a lone continuation byte, 0xff, a truncated sequence), so a text
 * decode anywhere on the way to receive-pack fails the comparison.
 */
const PACK_BYTES = Uint8Array.of(0x00, 0x80, 0xff, 0xfe, 0xc3, 0x28, 0x0a);
const DESC: ActionPresentation = { title: "push", implementsRevert: true };

function commitPayload(tree: string, parents: string[], message: string): Uint8Array {
  return new TextEncoder().encode([
    `tree ${tree}`,
    ...parents.map(parent => `parent ${parent}`),
    "author Ada Lovelace <ada@example.com> 1700000000 +0000",
    "committer Ada Lovelace <ada@example.com> 1700000100 +0000",
    "",
    `${message}\n`,
  ].join("\n"));
}

/** A git tree object with one regular file `README` at `blobOid`. */
function treePayload(blobOid: string): Uint8Array {
  const header = new TextEncoder().encode("100644 README\0");
  const oid = Uint8Array.from(blobOid.match(/../g)!.map(h => parseInt(h, 16)));
  const out = new Uint8Array(header.length + 20);
  out.set(header, 0);
  out.set(oid, header.length);
  return out;
}

/** Stands in for the workspace git cache: declared ancestry, served objects, stand-in pack bytes. */
class TestGitCache extends RpcTarget {
  readonly objects = new Map<GitOid, { type: GitObjectType; content: Uint8Array }>();
  readonly ancestries = new Set<string>();
  buildPackCalls = 0;

  withCommit(oid: GitOid, payload: Uint8Array): this {
    this.objects.set(oid, { type: "commit", content: payload });
    return this;
  }

  withTree(oid: GitOid, payload: Uint8Array): this {
    this.objects.set(oid, { type: "tree", content: payload });
    return this;
  }

  withBlob(oid: GitOid, text: string): this {
    this.objects.set(oid, { type: "blob", content: new TextEncoder().encode(text) });
    return this;
  }

  withAncestry(ancestor: GitOid, descendant: GitOid): this {
    this.ancestries.add(`${ancestor}:${descendant}`);
    return this;
  }

  async isAncestor(ancestor: GitOid, descendant: GitOid): Promise<boolean> {
    if (!this.objects.has(descendant)) throw new Error(`Cannot check ancestry: ${descendant} is not cached.`);
    return ancestor === descendant || this.ancestries.has(`${ancestor}:${descendant}`);
  }

  async get(id: GitOid): Promise<{ type: GitObjectType; content: Uint8Array } | null> {
    return this.objects.get(id) ?? null;
  }

  async buildPack(): Promise<ReadableStream<Uint8Array>> {
    this.buildPackCalls += 1;
    return new ReadableStream({ start(c) { c.enqueue(PACK_BYTES); c.close(); } });
  }

  /** What the next `consumePack` reports as received (the fake upload-pack sends an empty pack). */
  packOids: GitOid[] = [];

  async consumePack(pack: ReadableStream<Uint8Array>): Promise<GitOid[]> {
    await new Response(pack).arrayBuffer();
    return this.packOids;
  }
}

function stubOf(cache: TestGitCache): never {
  return new RpcStub(cache) as never;
}

function pktLines(...lines: string[]): Uint8Array {
  const pieces = [...lines.map(encodePktLine), FLUSH_PKT];
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const piece of pieces) { out.set(piece, offset); offset += piece.byteLength; }
  return out;
}

/** A GitLab with a project, live branches, commits, compare/merge_base, and captured git POSTs. */
class GitFake extends FakeGitLab {
  readonly branches = new Map<string, string>();
  readonly commits = new Set<string>();
  readonly receivePackBodies: Uint8Array[] = [];
  readonly receivePackResponses: Uint8Array[] = [];
  readonly uploadPackBodies: Uint8Array[] = [];

  constructor() {
    super();
    this.on("GET", new RegExp(`^/api/v4/projects/${P}$`), () => json({
      ...fx.projectResponse.data, path_with_namespace: PROJECT, default_branch: "main",
      web_url: `https://gitlab.example.com/${PROJECT}`, namespace: { ...fx.projectResponse.data.namespace, full_path: "group/sub" },
    }));
    this.on("GET", /^\/api\/v4\/user$/, () => json(fx.currentUserResponse.data));
    this.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/branches/`), request => {
      const name = decodeURIComponent(request.url.pathname.split("/repository/branches/")[1]);
      const head = this.branches.get(name);
      return head === undefined ? json({ message: "404 Branch Not Found" }, { status: 404 })
        : json({ name, protected: false, default: name === "main", commit: { id: head } });
    });
    this.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/branches\\?`), () =>
      json([...this.branches].map(([name, id]) => ({ name, protected: false, default: name === "main", commit: { id } }))));
    this.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/commits/`), request => {
      const ref = decodeURIComponent(request.url.pathname.split("/repository/commits/")[1]);
      const id = this.branches.get(ref) ?? (this.commits.has(ref) ? ref : undefined);
      return id === undefined ? json({ message: "404 Commit Not Found" }, { status: 404 })
        : json({ ...fx.commitResponse.data, id, parent_ids: [], title: `rest ${ref}`, message: `rest ${ref}` });
    });
    this.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/commits\\?`), request =>
      json(this.branches.has(request.url.searchParams.get("ref_name")!) || this.commits.has(request.url.searchParams.get("ref_name")!)
        ? [{ ...fx.commitResponse.data, id: BASE, parent_ids: [], title: "base", message: "base" }] : []));
    this.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/compare`), request => {
      const resolve = (ref: string) => this.branches.get(ref) ?? ref;
      const from = request.url.searchParams.get("from")!;
      const to = request.url.searchParams.get("to")!;
      return json({ ...fx.compareResponse.data,
        commits: resolve(from) === resolve(to) ? []
          : [{ ...fx.commitResponse.data, id: resolve(to), parent_ids: [BASE], title: "anchor", message: "anchor" }],
        diffs: [] });
    });
    this.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/merge_base`), () =>
      json({ ...fx.mergeBaseResponse.data, id: BASE }));
    this.on("POST", new RegExp(`^/${PROJECT}\\.git/git-receive-pack$`), async request => {
      this.receivePackBodies.push(request.bytes ?? new Uint8Array());
      const response = this.receivePackResponses.shift();
      if (!response) throw new Error("test: unexpected receive-pack request");
      return new Response(response, { headers: { "Content-Type": "application/x-git-receive-pack-result" } });
    });
    this.on("POST", new RegExp(`^/${PROJECT}\\.git/git-upload-pack$`), async request => {
      this.uploadPackBodies.push(request.bytes ?? new Uint8Array());
      // An empty packfile section: acknowledgments then packfile with nothing in it.
      return new Response(pktLines("packfile"), { headers: { "Content-Type": "application/x-git-upload-pack-result" } });
    });
  }

  respondToPush(...lines: string[]): void {
    this.receivePackResponses.push(pktLines(...lines));
  }
}

let scenario = 0;
async function setup(): Promise<{ gitlab: GitFake; props: GatekeeperProps; name: string }> {
  const gitlab = new GitFake();
  gitlab.branches.set("main", BASE);
  gitlab.commits.add(BASE);
  gitlab.install();
  const id = await seedAccount();
  return { gitlab, props: projectProps(id, PROJECT), name: `push-${scenario++}` };
}

function cacheWithChain(): TestGitCache {
  return new TestGitCache()
    .withCommit(HEAD1, commitPayload(TREE1, [BASE], "first"))
    .withCommit(HEAD2, commitPayload(TREE2, [HEAD1], "second"))
    .withAncestry(BASE, HEAD1).withAncestry(BASE, HEAD2).withAncestry(HEAD1, HEAD2);
}

async function queuePush(name: string, props: GatekeeperProps, branch: string, commit: string, force: boolean, cache: TestGitCache) {
  return await unwrap(await hooks().queuePush(name, props, [branch, commit, force, stubOf(cache)], DESC));
}

/**
 * Merge request !133 from `feature` (at SOURCE) into `main`, both forked from BASE, with `main` a
 * line of `merges` target commits and `/merge_base` answered from that history as git answers it.
 * Queued on `feature`: one merge of each target commit in turn, so the head contains the target
 * head -- then, with `unrelated`, a merge of ROOT, a parentless commit GitLab has.
 */
async function queuedMergesOfTarget(merges: number, { unrelated = false } = {}) {
  const SOURCE = "5".repeat(40);
  const ROOT = "6".repeat(40);
  const targets = Array.from({ length: merges }, (_, index) => `${index + 1}f`.repeat(20));
  const sides = unrelated ? [...targets, ROOT] : targets;
  const mergeCommits = sides.map((_, index) => `${index + 1}e`.repeat(20));
  const [TARGET_TREE, MERGE_TREE] = ["8".repeat(40), "9".repeat(40)];
  const [baseBlob, targetBlob, mergeBlob] = ["ab".repeat(20), "cd".repeat(20), "ef".repeat(20)];
  const target = targets.at(-1)!;
  const head = mergeCommits.at(-1)!;

  const { gitlab, props, name } = await setup();
  gitlab.branches.set("main", target).set("feature", SOURCE);
  const parents = new Map<string, string[]>([[BASE, []], [SOURCE, [BASE]], [ROOT, []],
    ...targets.map((id, index): [string, string[]] => [id, [targets[index - 1] ?? BASE]])]);
  for (const id of parents.keys()) gitlab.commits.add(id);
  const ancestors = (oid: string): string[] => [oid, ...parents.get(oid)!.flatMap(ancestors)];
  gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/merge_base`), request => {
    // `git merge-base A B...`: A against a hypothetical merge of the rest.
    const [first, ...rest] = request.url.searchParams.getAll("refs[]");
    const others = new Set(rest.flatMap(ancestors));
    const common = ancestors(first).filter(oid => others.has(oid));
    const best = common.find(oid => common.every(other => other === oid || !ancestors(other).includes(oid)));
    return best === undefined ? json({ message: "404 Merge Base Not Found" }, { status: 404 })
      : json({ ...fx.mergeBaseResponse.data, id: best });
  });
  const MR = { ...fx.mergeRequestResponse.data, iid: 133, source_branch: "feature", target_branch: "main", sha: SOURCE,
    source_project_id: 1, target_project_id: 1, diff_refs: { base_sha: BASE, start_sha: target, head_sha: SOURCE } };
  gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133\\?`), () => json(MR));

  // BASE's tree too, so a simulation that took BASE for the merge base would diff, not degrade.
  const cache = new TestGitCache()
    .withCommit(BASE, commitPayload(BASE_TREE, [], "base"))
    .withCommit(target, commitPayload(TARGET_TREE, [targets.at(-2) ?? BASE], "target"))
    .withTree(BASE_TREE, treePayload(baseBlob)).withTree(TARGET_TREE, treePayload(targetBlob)).withTree(MERGE_TREE, treePayload(mergeBlob))
    .withBlob(baseBlob, "base\n").withBlob(targetBlob, "base\ntarget\n").withBlob(mergeBlob, "source\nbase\ntarget\n")
    .withAncestry(SOURCE, head);
  for (const [index, id] of mergeCommits.entries()) {
    cache.withCommit(id, commitPayload(MERGE_TREE, [mergeCommits[index - 1] ?? SOURCE, sides[index]], `merge ${index + 1}`));
  }
  await queuePush(name, props, "feature", head, false, cache);
  return { gitlab, props, name, cache, head, target };
}

describe("queueing a push", () => {
  it("binds the expected old head from the live branch and requires a fast-forward", async () => {
    const { props, name } = await setup();
    const cache = cacheWithChain();
    const action = await queuePush(name, props, "main", HEAD1, false, cache);
    expect(action).toMatchObject({ type: "push", branch: "main", expectedOldSha: BASE, newSha: HEAD1, force: false });

    // Not a fast-forward from the (simulated) head: refused before anything is queued.
    const unrelated = new TestGitCache().withCommit(OTHER, commitPayload(TREE1, [], "root"));
    await expect(queuePush(name, props, "main", OTHER, false, unrelated)).rejects.toThrow(/not a fast-forward/);
    // Force skips only the policy check.
    const forced = await queuePush(name, props, "main", OTHER, true, unrelated);
    expect(forced).toMatchObject({ expectedOldSha: HEAD1, force: true });
  });

  it("stacks: the second push's expectation is the first's new head, and a no-op push queues nothing", async () => {
    const { props, name } = await setup();
    const cache = cacheWithChain();
    await queuePush(name, props, "main", HEAD1, false, cache);
    const second = await queuePush(name, props, "main", HEAD2, false, cache);
    expect(second).toMatchObject({ expectedOldSha: HEAD1, newSha: HEAD2 });
    expect(await queuePush(name, props, "main", HEAD2, false, cache)).toBeNull();
  });

  it("creating a branch binds the zero id and is exempt from the fast-forward check", async () => {
    const { props, name } = await setup();
    const cache = new TestGitCache().withCommit(OTHER, commitPayload(TREE1, [], "root"));
    const action = await queuePush(name, props, "feature", OTHER, false, cache);
    expect(action).toMatchObject({ branch: "feature", expectedOldSha: ZERO_OID, newSha: OTHER });
  });
});

describe("simulated reads over queued pushes", () => {
  it("shows the branch at its simulated head in listBranches, resolveRef, and getCommit -- from the cache, withheld from advertising", async () => {
    const { props, name } = await setup();
    const cache = cacheWithChain();
    await queuePush(name, props, "main", HEAD1, false, cache);
    await queuePush(name, props, "feature", HEAD2, false, cache);

    const branches = await unwrap(await hooks().listBranchesAll(name, props, 20));
    expect(new Map(branches.map(b => [b.name, b.headCommit]))).toEqual(new Map([["main", HEAD1], ["feature", HEAD2]]));
    expect(await unwrap(await hooks().isSimulatedCommitId(name, props, HEAD1))).toBe(true);
    expect(await unwrap(await hooks().isSimulatedCommitId(name, props, BASE))).toBe(false);

    const resolved = await unwrap(await hooks().resolveRef(name, props, "main", stubOf(cache)));
    expect(resolved).toEqual({ id: HEAD1, fromCache: true });
    const commit = await unwrap(await hooks().getCommit(name, props, "main", stubOf(cache)));
    expect(commit.fromCache).toBe(true);
    expect(commit.details).toMatchObject({ id: HEAD1, message: "first", parents: [BASE], author: { name: "Ada Lovelace" } });
    expect(commit.details.url).toBe(`https://gitlab.example.com/${PROJECT}/-/commit/${HEAD1}`);
    // A queued-push commit id GitLab does not know is served from the cache too.
    const byId = await unwrap(await hooks().getCommit(name, props, HEAD2, stubOf(cache)));
    expect(byId).toMatchObject({ fromCache: true, details: { id: HEAD2 } });
    // Without a cache, the remote is the truth.
    const remote = await unwrap(await hooks().resolveRef(name, props, "main"));
    expect(remote).toEqual({ id: BASE, fromCache: false });
  });

  it("serves a full commit id GitLab lacks from the cache only when a queued push will land it", async () => {
    const { props, name } = await setup();
    const cache = cacheWithChain().withCommit(OTHER, commitPayload(TREE1, [], "unrelated"));
    await queuePush(name, props, "main", HEAD2, false, cache);
    // HEAD1 is mid-chain: no push names it, but the walk down from main's queued head reaches it.
    expect(await unwrap(await hooks().isSimulatedCommitId(name, props, HEAD1))).toBe(false);
    const mid = await unwrap(await hooks().getCommit(name, props, HEAD1, stubOf(cache)));
    expect(mid).toMatchObject({ fromCache: true, details: { id: HEAD1, message: "first" } });
    expect(await unwrap(await hooks().resolveRef(name, props, HEAD1, stubOf(cache)))).toEqual({ id: HEAD1, fromCache: true });
    // The cache holds OTHER, but no queued push reaches it: not GitLab's commit, and not ours to show.
    await expect(unwrap(await hooks().getCommit(name, props, OTHER, stubOf(cache)))).rejects.toThrow(/No commit found/);
    await expect(unwrap(await hooks().resolveRef(name, props, OTHER, stubOf(cache)))).rejects.toThrow(/No commit found/);
  });

  it("injects the pending chain ahead of the remote history in listCommits", async () => {
    const { props, name } = await setup();
    const cache = cacheWithChain();
    await queuePush(name, props, "main", HEAD2, false, cache);
    const commits = await unwrap(await hooks().listCommitsAll(name, props, 20, stubOf(cache)));
    expect(commits.map(c => c.id)).toEqual([HEAD2, HEAD1, BASE]);
  });

  it("filters the pending chain by author as GitLab does: any part of `Name <email>`, case and all", async () => {
    const { props, name } = await setup();
    const cache = cacheWithChain();
    await queuePush(name, props, "main", HEAD2, false, cache);
    // The fake answers GitLab's part of the history, BASE, whatever the filter.
    const listed = async (author: string) =>
      (await unwrap(await hooks().listCommitsAll(name, props, 20, stubOf(cache), { author }))).map(commit => commit.id);
    expect(await listed("ada@")).toEqual([HEAD2, HEAD1, BASE]);
    expect(await listed("Lovelace <ada@example.com>")).toEqual([HEAD2, HEAD1, BASE]);
    expect(await listed("ADA")).toEqual([BASE]);
  });

  it("marks a local merge's side parent as simulated, so it is withheld from advertising", async () => {
    // M merges local SIDE into HEAD1; the listing follows first parents (M, HEAD1, BASE) and
    // never shows SIDE -- but M's summary names SIDE as a parent, and the session advertises what
    // it names. An advertised SIDE would be "remote-known" to the overseer, dropped from the push
    // pack, and the push would be rejected for the missing object.
    const SIDE = "d".repeat(40);
    const M = "e".repeat(40);
    const { props, name } = await setup();
    const cache = cacheWithChain()
      .withCommit(SIDE, commitPayload(TREE1, [BASE], "side"))
      .withCommit(M, commitPayload(TREE2, [HEAD1, SIDE], "merge"))
      .withAncestry(BASE, SIDE).withAncestry(BASE, M).withAncestry(HEAD1, M).withAncestry(SIDE, M);
    await queuePush(name, props, "main", M, false, cache);
    const commits = await unwrap(await hooks().listCommitsAll(name, props, 20, stubOf(cache)));
    expect(commits.map(c => c.id)).toEqual([M, HEAD1, BASE]);
    expect(commits[0].parents).toEqual([HEAD1, SIDE]);
    for (const id of [M, HEAD1, SIDE]) {
      expect(await unwrap(await hooks().isSimulatedCommitId(name, props, id)), id).toBe(true);
    }
    expect(await unwrap(await hooks().isSimulatedCommitId(name, props, BASE))).toBe(false);
  });

  it("lists no queued merge whose side parents it could not all withhold, past the side walk's cap", async () => {
    // An octopus merge with more unpushed side parents than the walk marks. Listed, M would name
    // a parent left unmarked, which the session advertises as GitLab's and the push pack then
    // omits. The walk fails instead, and the listing falls back to GitLab's history. Reaching the
    // cap takes 251 sequential GitLab probes and cache reads: about 1 s alone, over 5 s on a
    // loaded CI runner, hence the timeout.
    const M = "e".repeat(40);
    const sides = Array.from({ length: 251 }, (_, index) => `8${index.toString(16).padStart(39, "0")}`);
    const { props, name } = await setup();
    const cache = cacheWithChain()
      .withCommit(M, commitPayload(TREE2, [HEAD1, ...sides], "octopus"))
      .withAncestry(BASE, M);
    for (const id of sides) cache.withCommit(id, commitPayload(TREE1, [BASE], "side"));
    await queuePush(name, props, "main", M, false, cache);
    const commits = await unwrap(await hooks().listCommitsAll(name, props, 20, stubOf(cache)));
    expect(commits.map(c => c.id)).toEqual([BASE]);
  }, 30_000);

  it("still withholds a local merge's side parent when a restarted gatekeeper serves the stored comparison", async () => {
    // The merge request's comparison over the queued merge is stored for a while; a restart in
    // that window empties the in-memory withhold set, and the stored copy must refill it whole --
    // SIDE included, or the next read advertises it and the push pack leaves it out.
    const SIDE = "d".repeat(40);
    const M = "e".repeat(40);
    const blob = "f".repeat(40);
    const { gitlab, props, name } = await setup();
    gitlab.branches.set("feature", BASE);
    const MR = { ...fx.mergeRequestResponse.data, iid: 133, source_branch: "feature", target_branch: "main", sha: BASE,
      source_project_id: 1, target_project_id: 1, diff_refs: { base_sha: BASE, start_sha: BASE, head_sha: BASE } };
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133\\?`), () => json(MR));
    const cache = cacheWithChain()
      .withCommit(BASE, commitPayload(BASE_TREE, [], "base"))
      .withCommit(SIDE, commitPayload(TREE1, [BASE], "side"))
      .withCommit(M, commitPayload(TREE2, [HEAD1, SIDE], "merge"))
      .withTree(BASE_TREE, treePayload(blob)).withTree(TREE2, treePayload(blob)).withBlob(blob, "hello\n")
      .withAncestry(BASE, M);
    await queuePush(name, props, "feature", M, false, cache);
    await unwrap(await hooks().mergeRequestCommitsAll(name, props, "133", stubOf(cache)));

    await hooks().restart(name);
    await unwrap(await hooks().mergeRequestCommitsAll(name, props, "133", stubOf(cache)));
    for (const id of [M, HEAD1, SIDE]) {
      expect(await unwrap(await hooks().isSimulatedCommitId(name, props, id)), id).toBe(true);
    }
  });

  it("reads a queued merge request's diff, commits, and merge base as if the pushes had landed", async () => {
    const { gitlab, props, name } = await setup();
    const blobOld = "e".repeat(40);
    const blobNew = "f".repeat(40);
    const cache = cacheWithChain()
      .withCommit(BASE, commitPayload(BASE_TREE, [], "base"))
      .withTree(BASE_TREE, treePayload(blobOld)).withTree(TREE1, treePayload(blobNew)).withTree(TREE2, treePayload(blobNew))
      .withBlob(blobOld, "hello\n").withBlob(blobNew, "hello world\n");
    await queuePush(name, props, "feature", HEAD2, false, cache);
    const mr = await unwrap(await hooks().queueAction(name, props, "prepareCreateMergeRequest",
      [{ title: "Feature", sourceBranch: "feature", targetBranch: "main" }], DESC));
    expect(mr).toMatchObject({ type: "createMergeRequest", provisionalId: "~1" });

    const details = await unwrap(await hooks().openMergeRequest(name, props, "~1", stubOf(cache)));
    expect(details).toMatchObject({ id: "~1", source: { branch: "feature", sha: HEAD2 }, target: { branch: "main", sha: BASE }, changedFiles: 1 });

    const diff = await unwrap(await hooks().diffAll(name, props, "~1", stubOf(cache)));
    expect(diff.revision).toEqual({ baseSha: BASE, headSha: HEAD2, mergeBaseSha: BASE });
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]).toMatchObject({ path: "README", status: "modified", additions: 1, deletions: 1 });
    expect(diff.files[0].hunks[0].lines.map(l => `${l.kind}:${l.text}`)).toEqual(["removed:hello", "added:hello world"]);

    const commits = await unwrap(await hooks().mergeRequestCommitsAll(name, props, "~1", stubOf(cache)));
    // GitLab's compare(main, anchor) yields nothing (same ref); the pending chain follows oldest first.
    expect(commits.map(c => c.id)).toEqual([HEAD1, HEAD2]);
    expect(await unwrap(await hooks().mergeBase(name, props, "~1", stubOf(cache)))).toBe(BASE);
    // GitLab was asked about the anchor, never the pending commits.
    expect(gitlab.count("GET", new RegExp(`/repository/commits/${HEAD2}`))).toBeGreaterThan(0);
    expect(gitlab.count("GET", /repository\/compare/)).toBeGreaterThan(0);
  });

  it("binds a merge queued behind a push to the head that push will leave, and says so when applied first", async () => {
    // The worktree flow: push to the source branch, then merge -- both queued, approved in order.
    // The merge's compare-and-swap must name the pushed commit, or the push landing first makes
    // the merge fail as "head moved" on exactly the state it was meant to merge.
    const { gitlab, props, name } = await setup();
    gitlab.branches.set("feature", BASE);
    const MR = { ...fx.mergeRequestResponse.data, iid: 133, source_branch: "feature", target_branch: "main",
      sha: BASE, source_project_id: 1, target_project_id: 1, diff_refs: { base_sha: BASE, start_sha: BASE, head_sha: BASE } };
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133\\?`), () => json(MR));
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/approvals`), () => json({ approved_by: [] }));
    const cache = cacheWithChain();
    await queuePush(name, props, "feature", HEAD2, false, cache);
    const merge = await unwrap(await hooks().queueAction(name, props, "prepareMergeMergeRequest", ["133", {}], DESC));
    expect(merge).toMatchObject({ type: "mergeMergeRequest", expectedHeadSha: HEAD2 });
    // Approved out of order, the merge meets GitLab's 409 for a head that has not arrived yet:
    // the reason given is the push it waits on, not a branch that moved.
    gitlab.on("PUT", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/merge$`), () =>
      json({ message: "SHA does not match HEAD of source branch" }, { status: 409 }));
    await expect(unwrap(await hooks().applyAction(name, props, merge.approvalId)))
      .rejects.toThrow(/approved at c{40}, the head the queued push to "feature" will leave. Approve that push first/);
  });

  it("reads an existing merge request's diff at its simulated head even when GitLab's own is over its limits", async () => {
    // GitLab's limits cut the diff of the remote head; the simulated diff is computed whole.
    const { gitlab, props, name } = await setup();
    gitlab.branches.set("feature", BASE);
    const MR = { ...fx.mergeRequestResponse.data, iid: 133, source_branch: "feature", target_branch: "main", sha: BASE,
      changes_count: "1000+", source_project_id: 1, target_project_id: 1, diff_refs: { base_sha: BASE, start_sha: BASE, head_sha: BASE } };
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133\\?`), () => json(MR));
    const blobOld = "e".repeat(40);
    const blobNew = "f".repeat(40);
    const cache = cacheWithChain()
      .withCommit(BASE, commitPayload(BASE_TREE, [], "base"))
      .withTree(BASE_TREE, treePayload(blobOld)).withTree(TREE1, treePayload(blobNew)).withTree(TREE2, treePayload(blobNew))
      .withBlob(blobOld, "hello\n").withBlob(blobNew, "hello world\n");
    await queuePush(name, props, "feature", HEAD2, false, cache);

    const diff = await unwrap(await hooks().diffAll(name, props, "133", stubOf(cache)));
    expect(diff.revision.headSha).toBe(HEAD2);
    expect(diff.files.map(file => file.path)).toEqual(["README"]);
  });

  it("takes a queued merge of the target into the source as GitLab will: the target head becomes the merge base", async () => {
    // The merge's first-parent anchor is SOURCE, whose merge base with the target is BASE -- but
    // the merge contains the target head, so once it lands GitLab diffs against that head, and
    // the target's own change is not the merge request's.
    const { props, name, cache, head, target } = await queuedMergesOfTarget(1);
    const diff = await unwrap(await hooks().diffAll(name, props, "133", stubOf(cache)));
    expect(diff.revision).toEqual({ baseSha: target, headSha: head, mergeBaseSha: target });
    expect(diff.files).toEqual([expect.objectContaining({ path: "README", additions: 1, deletions: 0 })]);
    expect(await unwrap(await hooks().mergeBase(name, props, "133", stubOf(cache)))).toBe(target);
  });

  it("finds the merge base of a chain of merges of the target in one request", async () => {
    // Five merges put SOURCE and five target commits on the frontier; GitLab is asked once, with
    // the target head and all of them.
    const { gitlab, props, name, cache, head, target } = await queuedMergesOfTarget(5);
    const diff = await unwrap(await hooks().diffAll(name, props, "133", stubOf(cache)));
    expect(diff.revision).toEqual({ baseSha: target, headSha: head, mergeBaseSha: target });
    expect(gitlab.count("GET", /\/repository\/merge_base/)).toBe(1);
  });

  it("leaves a queued merge of an unrelated history out of the merge base, as git does", async () => {
    // The merge of ROOT puts a commit on the frontier that shares no ancestor with the target.
    // Git passes over it, so the target head is still the merge base -- not an error that drops
    // the simulation back to GitLab's diff of the old head.
    const { props, name, cache, head, target } = await queuedMergesOfTarget(1, { unrelated: true });
    const diff = await unwrap(await hooks().diffAll(name, props, "133", stubOf(cache)));
    expect(diff.revision).toEqual({ baseSha: target, headSha: head, mergeBaseSha: target });
    expect(diff.files).toEqual([expect.objectContaining({ path: "README", additions: 1, deletions: 0 })]);
  });

  it("degrades to the remote read when the simulation cannot resolve a tree", async () => {
    const { props, name } = await setup();
    // Chain without tree objects: the diff cannot be computed, details still read.
    const cache = cacheWithChain();
    await queuePush(name, props, "feature", HEAD2, false, cache);
    await unwrap(await hooks().queueAction(name, props, "prepareCreateMergeRequest",
      [{ title: "Feature", sourceBranch: "feature", targetBranch: "main" }], DESC));
    const details = await unwrap(await hooks().openMergeRequest(name, props, "~1", stubOf(cache)));
    // Branch "feature" does not exist remotely; the simulated head still shows.
    expect(details.source.sha).toBe(HEAD2);
  });
});

describe("applying a push", () => {
  function parseRefUpdate(body: Uint8Array): { command: string; pack: Uint8Array } {
    const lenHex = new TextDecoder().decode(body.slice(0, 4));
    const len = parseInt(lenHex, 16);
    const command = pktText(body.slice(4, len)).split("\0")[0];
    return { command, pack: body.slice(len + 4) };  // after the flush-pkt
  }

  it("streams the overseer-built pack behind the queue-time CAS command", async () => {
    const { gitlab, props, name } = await setup();
    const cache = cacheWithChain();
    const action = await unwrap(await hooks().queueAction(name, props, "preparePush", ["main", HEAD1, false, stubOf(cache)], DESC));
    gitlab.respondToPush("unpack ok", "ok refs/heads/main");
    await unwrap(await hooks().applyAction(name, props, action.approvalId, stubOf(cache)));
    expect(cache.buildPackCalls).toBe(1);
    expect(gitlab.receivePackBodies).toHaveLength(1);
    const { command, pack } = parseRefUpdate(gitlab.receivePackBodies[0]);
    expect(command).toBe(`${BASE} ${HEAD1} refs/heads/main`);
    expect(pack).toEqual(PACK_BYTES);
    const request = gitlab.requests.find(r => r.url.pathname.endsWith("git-receive-pack"))!;
    expect(request.headers.get("authorization")).toBe(`Basic ${btoa("oauth2:test-token")}`);
    // Applied: a re-delivered apply (the overseer records completion only after the reply)
    // reports success from the retired record without touching GitLab -- a desired-state re-check
    // could not answer it, since the branch may since have moved on legitimately.
    await unwrap(await hooks().applyAction(name, props, action.approvalId, stubOf(cache)));
    expect(cache.buildPackCalls).toBe(1);
    expect(gitlab.receivePackBodies).toHaveLength(1);
  });

  it("fails cleanly when the branch moved, passing GitLab's reason through, and succeeds on desired state", async () => {
    const { gitlab, props, name } = await setup();
    const cache = cacheWithChain();
    const action = await unwrap(await hooks().queueAction(name, props, "preparePush", ["main", HEAD1, false, stubOf(cache)], DESC));
    // GitLab rejects (a protected-branch hook, say) and the branch is elsewhere.
    gitlab.branches.set("main", OTHER);
    gitlab.respondToPush("unpack ok", "ng refs/heads/main GitLab: You are not allowed to push code to protected branches on this project.");
    await expect(unwrap(await hooks().applyAction(name, props, action.approvalId, stubOf(cache))))
      .rejects.toThrow(/has moved from a{40}.*GitLab said: GitLab: You are not allowed to push code to protected branches/);
    // Desired state: the branch is already at newSha (a retried apply), so the CAS failure is success.
    gitlab.branches.set("main", HEAD1);
    gitlab.respondToPush("unpack ok", "ng refs/heads/main fetch first");
    await unwrap(await hooks().applyAction(name, props, action.approvalId, stubOf(cache)));
  });

  it("reverts by rolling the ref back with an empty pack, or deleting a created branch", async () => {
    const { gitlab, props, name } = await setup();
    const cache = cacheWithChain().withCommit(OTHER, commitPayload(TREE1, [], "root"));
    const move = await unwrap(await hooks().queueAction(name, props, "preparePush", ["main", HEAD1, false, stubOf(cache)], DESC));
    const create = await unwrap(await hooks().queueAction(name, props, "preparePush", ["feature", OTHER, false, stubOf(cache)], DESC));
    gitlab.respondToPush("unpack ok", "ok refs/heads/main");
    gitlab.respondToPush("unpack ok", "ok refs/heads/feature");
    await unwrap(await hooks().applyAction(name, props, move.approvalId, stubOf(cache)));
    await unwrap(await hooks().applyAction(name, props, create.approvalId, stubOf(cache)));

    gitlab.respondToPush("unpack ok", "ok refs/heads/main");
    expect(await unwrap(await hooks().revertAction(name, props, move.approvalId))).toBeUndefined();
    const rollback = parseRefUpdate(gitlab.receivePackBodies[2]);
    expect(rollback.command).toBe(`${HEAD1} ${BASE} refs/heads/main`);
    expect(rollback.pack).toEqual(await emptyPackBytes());  // not the overseer's pack

    gitlab.respondToPush("unpack ok", "ok refs/heads/feature");
    expect(await unwrap(await hooks().revertAction(name, props, create.approvalId))).toBeUndefined();
    const deletion = parseRefUpdate(gitlab.receivePackBodies[3]);
    expect(deletion.command).toBe(`${OTHER} ${ZERO_OID} refs/heads/feature`);
    expect(deletion.pack).toHaveLength(0);  // a deletion sends no pack

    // A rollback the remote refuses reports rather than throws.
    gitlab.respondToPush("unpack ok", "ng refs/heads/main non-fast-forward");
    const refused = await unwrap(await hooks().revertAction(name, props, move.approvalId));
    expect(refused).toMatchObject({ canRetry: false });
    expect(refused?.message).toMatch(/no longer at the pushed commit/);
  });
});

describe("rejecting a push", () => {
  it("cascades to a queued merge request whose source branch the push would have created", async () => {
    const { props, name } = await setup();
    const cache = cacheWithChain().withCommit(OTHER, commitPayload(TREE1, [], "root"));
    const push = await unwrap(await hooks().queueAction(name, props, "preparePush", ["feature", OTHER, false, stubOf(cache)], DESC));
    const mr = await unwrap(await hooks().queueAction(name, props, "prepareCreateMergeRequest",
      [{ title: "x", sourceBranch: "feature", targetBranch: "main" }], DESC));
    expect(await unwrap(await hooks().rejectAction(name, props, push.approvalId))).toEqual({ restart: true });
    await expect(unwrap(await hooks().applyAction(name, props, mr.approvalId))).rejects.toThrow(/something it depended on was/);
    // The branch injection is gone too.
    const branches = await unwrap(await hooks().listBranchesAll(name, props, 20));
    expect(branches.map(b => b.name)).toEqual(["main"]);
  });

  it("leaves a merge request alone when its branch still exists through another queued push", async () => {
    const { props, name } = await setup();
    const cache = cacheWithChain();
    const first = await unwrap(await hooks().queueAction(name, props, "preparePush", ["main", HEAD1, false, stubOf(cache)], DESC));
    const mr = await unwrap(await hooks().queueAction(name, props, "prepareCreateMergeRequest",
      [{ title: "x", sourceBranch: "main", targetBranch: "main" }], DESC));
    expect(await unwrap(await hooks().rejectAction(name, props, first.approvalId))).toBeUndefined();
    // Still queued: main exists remotely regardless.
    const log = await hooks().queueLog(name);
    expect(log.submitted.map(s => s.actionId)).toContain(mr.approvalId);
  });

  it("spares what is stacked on a head the branch already has", async () => {
    // HEAD1 reached main by other means while the push that would leave it was queued: rejecting
    // that push strands nothing, and the push stacked on HEAD1 still applies.
    const { gitlab, props, name } = await setup();
    const cache = cacheWithChain();
    const first = (await queuePush(name, props, "main", HEAD1, false, cache))!;
    const second = (await queuePush(name, props, "main", HEAD2, false, cache))!;
    gitlab.branches.set("main", HEAD1);
    expect(await unwrap(await hooks().rejectAction(name, props, first.approvalId))).toBeUndefined();
    gitlab.respondToPush("unpack ok", "ok refs/heads/main");
    await unwrap(await hooks().applyAction(name, props, second.approvalId, stubOf(cache)));
    expect(gitlab.receivePackBodies).toHaveLength(1);
  });

  it("retires the pushes and merges stacked on it, and a re-push lists the real history", async () => {
    // Two stacked pushes to main, with merges bound along the way, then the first push is
    // rejected. The second push's compare-and-swap could only fail -- blaming the branch for
    // moving -- and the merges bound to the heads that will never exist could only 409.
    const { gitlab, props, name } = await setup();
    const MR = { ...fx.mergeRequestResponse.data, iid: 133, source_branch: "main", target_branch: "stable",
      sha: BASE, source_project_id: 1, target_project_id: 1, diff_refs: { base_sha: BASE, start_sha: BASE, head_sha: BASE } };
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133\\?`), () => json(MR));
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/approvals`), () => json({ approved_by: [] }));
    gitlab.on("PUT", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/merge$`), () => json({ ...MR, state: "merged" }));
    const cache = cacheWithChain();
    const queueMerge = async () => await unwrap(await hooks().queueAction(name, props, "prepareMergeMergeRequest", ["133", {}], DESC));
    const atBase = await queueMerge();
    const first = (await queuePush(name, props, "main", HEAD1, false, cache))!;
    const atHead1 = await queueMerge();
    const second = (await queuePush(name, props, "main", HEAD2, false, cache))!;
    const atHead2 = await queueMerge();
    expect(atHead2).toMatchObject({ expectedHeadSha: HEAD2, sourceBranch: "main" });

    expect(await unwrap(await hooks().rejectAction(name, props, first.approvalId))).toEqual({ restart: true });
    for (const stranded of [second, atHead1, atHead2]) {
      await expect(unwrap(await hooks().applyAction(name, props, stranded.approvalId, stubOf(cache))))
        .rejects.toThrow(/something it depended on was/);
    }
    // The merge bound to the head GitLab has is untouched.
    await unwrap(await hooks().applyAction(name, props, atBase.approvalId));
    expect(JSON.parse(gitlab.requests.at(-1)!.body!)).toMatchObject({ sha: BASE });

    // Re-pushing HEAD2 from the real head walks down to BASE: no stranded push is left to vouch
    // for HEAD1 as GitLab's, which would list from HEAD1 and leave it unserved.
    await queuePush(name, props, "main", HEAD2, false, cache);
    const commits = await unwrap(await hooks().listCommitsAll(name, props, 20, stubOf(cache)));
    expect(commits.map(c => c.id)).toEqual([HEAD2, HEAD1, BASE]);
    expect(await unwrap(await hooks().isSimulatedCommitId(name, props, HEAD1))).toBe(true);
  });
});

describe("gitPull", () => {
  it("POSTs a protocol-v2 fetch for the requested oids and streams the pack into the cache", async () => {
    const { gitlab, props, name } = await setup();
    const cache = new TestGitCache();
    cache.packOids = [BASE];
    await unwrap(await hooks().gitPull(name, props, [BASE], stubOf(cache), { type: "commit", commitHistory: { kind: "depth", depth: 1 } }));
    expect(gitlab.uploadPackBodies).toHaveLength(1);
    const text = new TextDecoder().decode(gitlab.uploadPackBodies[0]);
    expect(text).toContain("command=fetch");
    expect(text).toContain(`want ${BASE}`);
    expect(text).not.toContain("have ");
    const request = gitlab.requests.find(r => r.url.pathname.endsWith("git-upload-pack"))!;
    expect(request.headers.get("git-protocol")).toBe("version=2");
    expect(request.headers.get("authorization")).toBe(`Basic ${btoa("oauth2:test-token")}`);
  });
});
