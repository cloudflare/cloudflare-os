// The push action on the real gatekeeper Durable Object: queue-time binding of the expected old
// head (stacked pushes compose; non-fast-forward refused; creation exempt), simulated reads over
// queued pushes (branch heads, refs, commits, history, an MR's diff and merge base), apply through
// receive-pack framing with the queue-time CAS and desired-state idempotency, revert by ref
// rollback or deletion, reject cascades, and the gitPull request framing. GitLab is faked at
// fetch; the workspace git cache is a stub the test controls.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionDescription, GitObjectType, GitOid } from "@gadgets/workshop-shared/gatekeeper";
import { FLUSH_PKT, ZERO_OID, encodePktLine, pktText } from "@gadgets/gatekeeper-kit/git-transport";
import * as fx from "../fixtures/gitlab-docs.js";
import { FakeGitLab, json, hooks, projectProps, seedAccount, unwrap as unwrapOutcome } from "./fake-gitlab.js";
import type { GatekeeperProps } from "./worker.js";

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
const PACK_BYTES = new TextEncoder().encode("PACK-STAND-IN");
const DESC: ActionDescription = { title: "push", description: "d", implementsRevert: true };

async function unwrap<T>(outcome: { ok: T } | { error: string }): Promise<NonNullable<T>> {
  const value = await unwrapOutcome(outcome);
  if (value === null || value === undefined) throw new Error("unexpected null result");
  return value as NonNullable<T>;
}

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
      this.receivePackBodies.push(new TextEncoder().encode(request.body ?? ""));
      const response = this.receivePackResponses.shift();
      if (!response) throw new Error("test: unexpected receive-pack request");
      return new Response(response, { headers: { "Content-Type": "application/x-git-receive-pack-result" } });
    });
    this.on("POST", new RegExp(`^/${PROJECT}\\.git/git-upload-pack$`), async request => {
      this.uploadPackBodies.push(new TextEncoder().encode(request.body ?? ""));
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
  return await unwrapOutcome(await hooks().queueAction(name, props, "preparePush", [branch, commit, force, stubOf(cache)], DESC));
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

  it("injects the pending chain ahead of the remote history in listCommits", async () => {
    const { props, name } = await setup();
    const cache = cacheWithChain();
    await queuePush(name, props, "main", HEAD2, false, cache);
    const commits = await unwrap(await hooks().listCommitsAll(name, props, 20, stubOf(cache)));
    expect(commits.map(c => c.id)).toEqual([HEAD2, HEAD1, BASE]);
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

  it("binds a merge queued behind a push to the head that push will leave, not the remote's", async () => {
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
  function parseRefUpdate(body: Uint8Array): { command: string; pack: string } {
    const lenHex = new TextDecoder().decode(body.slice(0, 4));
    const len = parseInt(lenHex, 16);
    const command = pktText(body.slice(4, len)).split("\0")[0];
    const rest = new TextDecoder().decode(body.slice(len + 4));  // after the flush-pkt
    return { command, pack: rest };
  }

  it("streams the overseer-built pack behind the queue-time CAS command", async () => {
    const { gitlab, props, name } = await setup();
    const cache = cacheWithChain();
    const action = await unwrap(await hooks().queueAction(name, props, "preparePush", ["main", HEAD1, false, stubOf(cache)], DESC));
    gitlab.respondToPush("unpack ok", "ok refs/heads/main");
    await unwrapOutcome(await hooks().applyAction(name, props, action.approvalId, stubOf(cache)));
    expect(cache.buildPackCalls).toBe(1);
    expect(gitlab.receivePackBodies).toHaveLength(1);
    const { command, pack } = parseRefUpdate(gitlab.receivePackBodies[0]);
    expect(command).toBe(`${BASE} ${HEAD1} refs/heads/main`);
    expect(pack).toBe("PACK-STAND-IN");
    const request = gitlab.requests.find(r => r.url.pathname.endsWith("git-receive-pack"))!;
    expect(request.headers.get("authorization")).toBe(`Basic ${btoa("oauth2:test-token")}`);
    // Applied: a re-delivered apply (the overseer records completion only after the reply)
    // reports success from the retired record without touching GitLab -- a desired-state re-check
    // could not answer it, since the branch may since have moved on legitimately.
    await unwrapOutcome(await hooks().applyAction(name, props, action.approvalId, stubOf(cache)));
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
    await unwrapOutcome(await hooks().applyAction(name, props, action.approvalId, stubOf(cache)));
  });

  it("reverts by rolling the ref back with an empty pack, or deleting a created branch", async () => {
    const { gitlab, props, name } = await setup();
    const cache = cacheWithChain().withCommit(OTHER, commitPayload(TREE1, [], "root"));
    const move = await unwrap(await hooks().queueAction(name, props, "preparePush", ["main", HEAD1, false, stubOf(cache)], DESC));
    const create = await unwrap(await hooks().queueAction(name, props, "preparePush", ["feature", OTHER, false, stubOf(cache)], DESC));
    gitlab.respondToPush("unpack ok", "ok refs/heads/main");
    gitlab.respondToPush("unpack ok", "ok refs/heads/feature");
    await unwrapOutcome(await hooks().applyAction(name, props, move.approvalId, stubOf(cache)));
    await unwrapOutcome(await hooks().applyAction(name, props, create.approvalId, stubOf(cache)));

    gitlab.respondToPush("unpack ok", "ok refs/heads/main");
    expect(await unwrapOutcome(await hooks().revertAction(name, props, move.approvalId))).toBeUndefined();
    const rollback = parseRefUpdate(gitlab.receivePackBodies[2]);
    expect(rollback.command).toBe(`${HEAD1} ${BASE} refs/heads/main`);
    expect(rollback.pack.startsWith("PACK")).toBe(true);  // an empty pack, not the stand-in

    gitlab.respondToPush("unpack ok", "ok refs/heads/feature");
    expect(await unwrapOutcome(await hooks().revertAction(name, props, create.approvalId))).toBeUndefined();
    const deletion = parseRefUpdate(gitlab.receivePackBodies[3]);
    expect(deletion.command).toBe(`${OTHER} ${ZERO_OID} refs/heads/feature`);
    expect(deletion.pack).toBe("");  // a deletion sends no pack

    // A rollback the remote refuses reports rather than throws.
    gitlab.respondToPush("unpack ok", "ng refs/heads/main non-fast-forward");
    const refused = await unwrapOutcome(await hooks().revertAction(name, props, move.approvalId));
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
    expect(await unwrapOutcome(await hooks().rejectAction(name, props, push.approvalId))).toEqual({ restart: true });
    await expect(unwrap(await hooks().applyAction(name, props, mr.approvalId))).rejects.toThrow(/no longer pending/);
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
    expect(await unwrapOutcome(await hooks().rejectAction(name, props, first.approvalId))).toBeUndefined();
    // Still queued: main exists remotely regardless.
    const log = await hooks().queueLog(name);
    expect(log.submitted.map(s => s.actionId)).toContain(mr.approvalId);
  });
});

describe("gitPull", () => {
  it("POSTs a protocol-v2 fetch for the requested oids and streams the pack into the cache", async () => {
    const { gitlab, props, name } = await setup();
    const cache = new TestGitCache();
    cache.packOids = [BASE];
    await unwrapOutcome(await hooks().gitPull(name, props, [BASE], stubOf(cache), { type: "commit", commitHistory: { kind: "depth", depth: 1 } }));
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
