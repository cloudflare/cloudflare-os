import {gitPullTransferOf} from "@gadgets/gatekeeper-kit/git-pull-transfer";
import type {GitObjectType, GitPullHints, GitPullTransfer, GitShallowInfo} from "@gadgets/workshop-shared/gatekeeper";
import type {WorktreeGitPullHints} from "@gadgets/workshop-shared/worktree-replica";
import {buildPackStream, mergePackStreams, parseGitCommitRefs, parseGitTree, readGitCommitHeader,
  type GitTreeEntry, type PackableObject} from "./git-codec";
import type {WorkspaceGitCache} from "./git-cache";

/** The parts of the workspace's Git store that serving a worktree's fetches reads through. */
type GitReads = Pick<WorkspaceGitCache, "ensureObject" | "ensureGitObjects" | "packEntry">;

/**
 * What `worktreeGitPull()` needs to know about one worktree, supplied by the overseer, which
 * checks access before each pull. The overseer decides where each object comes from; the client
 * (e.g. Git in a container) only ever sees one repository.
 */
export interface WorktreeGitSource {
  /** The worktree's latest commit (WorktreeRecord.headCommit): advertised as HEAD. */
  head: string;


  /**
   * The trees that may be fetched by ID: those the running execution handed out (see
   * `ReplicableWorktree.snapshot()`).
   */
  trees: ReadonlySet<string>;

  /**
   * The connections that can serve the history beyond the workspace's own commits. That history
   * starts at its *boundary*: walking back from `head` through the workspace's commits, the
   * first ones a connection has (the commit the worktree was created at, or one pushed or merged
   * in since). Each is in some connection's `haves`, the boundary commits that connection is
   * known to have; `pull` is its `Gatekeeper.gitPull()`. With no connections, all of the history
   * is in the workspace.
   *
   * A clone is cut off at the boundary, whose commits' files are streamed from a connection
   * rather than read from the workspace. Fetches of more history (e.g. a build script running
   * `git fetch --depth=1 origin <sha>`, or `git fetch --deepen`) are proxied whole.
   */
  remotes: {haves: string[]; pull(oids: string[], hints: GitPullHints): Promise<RemotePack>}[];
}

/** A pack pulled from a connection, and the shallow boundary it reported. */
export interface RemotePack {
  pack: ReadableStream<Uint8Array>;
  shallow: GitShallowInfo;
}

/** Git's depth for "all history", as sent by `git fetch --unshallow`. */
const INFINITE_DEPTH = 0x7fffffff;

/** Throws unless `hints` hold only object IDs and whole, positive depths. */
function checkHints(oids: string[], hints: WorktreeGitPullHints): void {
  if (!oids.length) throw new Error("The Git pull wants nothing.");
  for (const oid of [...oids, ...hints.haves ?? [], ...hints.shallow ?? []])
    if (!/^[0-9a-f]{40}$/.test(oid)) throw new Error("Invalid object ID in Git pull.");
  const history = hints.commitHistory;
  if ((history.kind === "depth" || history.kind === "relative") &&
      !(Number.isSafeInteger(history.depth) && history.depth > 0)) throw new Error("Invalid depth in Git pull.");
  if (history.kind === "since" && Number.isNaN(history.since.getTime())) throw new Error("Invalid date in Git pull.");
}

/**
 * Serve a Git pull of one worktree; see `ReplicableWorktree.gitPull()`. The worktree's own
 * commits are built from workspace storage, while the files of the history's boundary commits
 * are streamed through from a connection rather than loaded into the workspace. History beyond
 * the boundary is proxied from a connection.
 */
export async function worktreeGitPull(cache: GitReads, source: WorktreeGitSource,
    oids: string[], hints: WorktreeGitPullHints): Promise<GitPullTransfer> {
  checkHints(oids, hints);
  const {pack, shallow} = await servePull(cache, source, {...hints, wants: oids,
    haves: hints.haves ?? [], shallow: hints.shallow ?? []});
  return gitPullTransferOf(pack, shallow);
}

/** A pull's hints, with its wants and the lists it may leave out. */
type FetchRequest = WorktreeGitPullHints & {wants: string[]; haves: string[]; shallow: string[]};

async function servePull(cache: GitReads, source: WorktreeGitSource, fetch: FetchRequest): Promise<RemotePack> {
  // Decide by what the client lacks, not by what it names: e.g. `git fetch --deepen=1` wants
  // the head the client already has, and lacks only history beyond the shallow boundary.
  const boundary = new Set(source.remotes.flatMap(remote => remote.haves));
  const history = await localHistory(cache, source, boundary);
  if (fetch.wants.some(oid => source.trees.has(oid))) return treeFetch(cache, source, history, boundary, fetch);
  const has = commonHistory(history, boundary, fetch);
  const remoteWants = fetch.wants.filter(oid => !history.has(oid) && !boundary.has(oid));
  const needsLocal = fetch.wants.some(oid => history.has(oid) && !has.has(oid));
  const reached = reachedBoundary(history, boundary, fetch.wants);
  const deeper = await wantsDeeperHistory(cache, reached, fetch);
  if (!needsLocal && (remoteWants.length || deeper)) {
    // All the client lacks is remote history: proxy it whole.
    const bases = [...reached.keys()].filter(oid => deeper || fetch.wants.includes(oid));
    return proxyFetch(source, fetch, remoteWants, bases, bases.filter(oid => has.has(oid)),
      deeper ? Math.min(...reached.values()) : undefined);
  }
  if (needsLocal && (remoteWants.length || deeper && has.size)) {
    // Serving this would mean merging a local pack with a proxied one that may contain some of
    // the same objects, which Git rejects; see plans/tree-sync-replicas.md. A replica that
    // fetches the worktree's head before any older history never needs both. (A clone deeper
    // than the boundary is given less history instead, as any shallow server gives it.)
    throw new Error("This fetch needs both new commits from the workspace and older history from the " +
      "connected repository. Fetch the worktree's head first, then fetch again.");
  }

  // Serve the workspace's commits the client lacks, plus the boundary commits they reach that it
  // lacks, at depth 1 from a connection.
  let pack = await localPack(cache, source, boundary, [...reached.keys()], fetch.wants, has);
  const lacking = [...reached.keys()].filter(oid => !has.has(oid));
  let shallow: GitShallowInfo = {shallow: [], unshallow: []};
  if (lacking.length) {
    const upstream = await pullBoundary(source, lacking);
    pack = await mergePackStreams([upstream.pack, pack]);
    shallow = upstream.shallow;
  }
  return {pack, shallow};
}

/**
 * Serve a fetch of trees from `source.trees`, built from the workspace: everything they hold
 * that the trees of the client's commits (its `haves` in the history) don't hold at the same
 * path. For a worktree from a connected repository, the client must have one: the rest of a
 * tree is mostly files the workspace would have to pull.
 */
async function treeFetch(cache: GitReads, source: WorktreeGitSource,
    history: Map<string, string[]>, boundary: Set<string>, fetch: FetchRequest): Promise<RemotePack> {
  if (!fetch.wants.every(oid => source.trees.has(oid))) {
    throw new Error("Fetch a worktree's snapshot trees on their own, not together with commits.");
  }
  const haves = fetch.haves.filter(oid => history.has(oid) || boundary.has(oid));
  if (boundary.size && !haves.length) {
    throw new Error("Fetch the worktree's head before fetching a snapshot tree.");
  }
  const read = objectReader(cache);
  const previous: string[] = [];
  for (const oid of haves) previous.push(parseGitCommitRefs((await read(oid, "commit")).payload).tree);
  const objects: PackObjects = new Map();
  for (const tree of new Set(fetch.wants)) await collectTree(read, objects, tree, previous, new Map());
  return {pack: packObjects(cache, objects), shallow: {shallow: [], unshallow: []}};
}

/**
 * The workspace-stored commits of the history served: everything reachable from the worktree's
 * head, back to (not including) its `boundary`. Maps each commit to its parents.
 */
async function localHistory(cache: GitReads, source: WorktreeGitSource,
    boundary: Set<string>): Promise<Map<string, string[]>> {
  const history = new Map<string, string[]>();
  const stack = [source.head];
  while (stack.length) {
    const oid = stack.pop()!;
    if (boundary.has(oid) || history.has(oid)) continue;
    const commit = parseGitCommitRefs((await cache.ensureObject(oid, {type: "commit"})).payload);
    history.set(oid, commit.parents);
    if (history.size > 100_000) throw new Error("Worktree history exceeds its object budget.");
    stack.push(...commit.parents);
  }
  return history;
}

/**
 * The commits of `history` and `boundary` that the client has: those reachable from its `haves`.
 * Each `have` claims the commit's history, down to the client's shallow commits.
 */
function commonHistory(history: Map<string, string[]>, boundary: Set<string>, fetch: FetchRequest): Set<string> {
  const has = new Set<string>();
  const stack = fetch.haves.filter(oid => history.has(oid) || boundary.has(oid));
  while (stack.length) {
    const oid = stack.pop()!;
    if (has.has(oid)) continue;
    has.add(oid);
    if (!fetch.shallow.includes(oid)) stack.push(...history.get(oid) ?? []);
  }
  return has;
}

/**
 * The boundary commits `wants` reach through `history`, each with the depth (1 = a want itself)
 * at which it is first reached.
 */
function reachedBoundary(history: Map<string, string[]>, boundary: Set<string>, wants: string[]): Map<string, number> {
  const reached = new Map<string, number>();
  let level = [...new Set(wants)];
  const seen = new Set(level);
  for (let depth = 1; level.length; depth++) {
    for (const oid of level) if (boundary.has(oid)) reached.set(oid, depth);
    level = level.flatMap(oid => history.get(oid) ?? []).filter(oid => !seen.has(oid) && seen.add(oid));
  }
  return reached;
}

/**
 * Whether a fetch asks for history beyond the boundary commits its wants reach (`reached`), which
 * only a connection can serve: any relative deepen, an absolute depth reaching past the nearest
 * of them, or a date no later than one's commit time.
 */
async function wantsDeeperHistory(cache: GitReads, reached: Map<string, number>,
    fetch: FetchRequest): Promise<boolean> {
  const history = fetch.commitHistory;
  if (history.kind === "full" || !reached.size) return false;
  if (history.kind === "relative") return true;
  if (history.kind === "depth") return history.depth > Math.min(...reached.values());
  for (const oid of reached.keys()) {
    const commit = (await cache.ensureObject(oid, {type: "commit"})).payload;
    const time = /(\d+) [+-]\d{4}$/.exec(readGitCommitHeader(commit, "committer")[0] ?? "");
    if (!time || Number(time[1]) * 1000 >= history.since.getTime()) return true;
  }
  return false;
}

/**
 * Pack the workspace-stored history of `heads` back to the `boundary` (exclusive), leaving out
 * the commits the client `has` and their objects. Every object reachable from the trees of the
 * boundary commits in `bases` is left out too, whatever its path (a rename, copy or revert reuses
 * one): either the client has it, or the connection's pack streamed alongside this one supplies
 * it, and native Git rejects a pack holding an object twice. Only those trees are read, never
 * their blobs.
 */
async function localPack(cache: GitReads, source: WorktreeGitSource,
    boundary: Set<string>, bases: string[], heads: string[], has: Set<string>): Promise<ReadableStream<Uint8Array>> {
  const read = objectReader(cache);
  const skip = new Set<string>();
  let level: string[] = [];
  for (const oid of bases) level.push(parseGitCommitRefs((await read(oid, "commit")).payload).tree);
  while (level.length) {
    level = level.filter(oid => !skip.has(oid) && skip.add(oid));
    // A merged-in commit's trees may not be stored yet: fetch those missing in one pull, as
    // metadata only, which brings their subtrees too.
    await cache.ensureGitObjects(level, {type: "tree", commitHistory: {kind: "depth", depth: 1}, filterBlobSize: 0});
    const next: string[] = [];
    for (const oid of level) {
      for (const entry of parseGitTree((await read(oid, "tree")).payload)) {
        if (entry.mode === "40000") next.push(entry.oid); else skip.add(entry.oid);
      }
    }
    level = next;
  }
  // Collect the objects of `commits`, and of their history if `follow`, into `objects`, leaving
  // out anything `known`.
  const collect = async (commits: Iterable<string>, follow: boolean, objects: PackObjects, known: Known) => {
    const stack = [...new Set(commits)];
    while (stack.length) {
      const oid = stack.pop()!;
      if (boundary.has(oid) || objects.has(oid) || known.has(oid)) continue;
      addObject(objects, oid, "commit");
      const commit = parseGitCommitRefs((await read(oid, "commit")).payload);
      await collectTree(read, objects, commit.tree, [], known);
      if (follow) stack.push(...commit.parents);
    }
  };
  const present: PackObjects = new Map();
  await collect(has, false, present, skip);
  const objects: PackObjects = new Map();
  await collect(heads, true, objects, {has: oid => skip.has(oid) || present.has(oid)});
  return packObjects(cache, objects);
}

/** Objects to send, by ID, with their types and the trees referring to blobs (for pull hints). */
type PackObjects = Map<string, {type: GitObjectType; referencedBy?: string}>;

/** Objects to leave out of a pack, by ID. */
type Known = {has(oid: string): boolean};

/** Reads an object, faulting it in if needed. */
type ReadObject = (oid: string, type: GitObjectType, referencedBy?: string) => Promise<PackableObject>;

function objectReader(cache: GitReads): ReadObject {
  return (oid, type, referencedBy) => cache.ensureObject(oid, {type, referencedBy});
}

function addObject(objects: PackObjects, oid: string, type: GitObjectType, referencedBy?: string): void {
  objects.set(oid, {type, referencedBy});
  if (objects.size > 100_000) throw new Error("Worktree history exceeds its object budget.");
}

/**
 * Collect tree `oid` and what it holds into `objects`, leaving out anything in `objects` or
 * `skip` already, and what any of the `previous` trees (which the client has) holds at the same
 * path.
 */
async function collectTree(read: ReadObject, objects: PackObjects, oid: string, previous: string[],
    skip: Known): Promise<void> {
  if (previous.includes(oid) || objects.has(oid) || skip.has(oid)) return;
  addObject(objects, oid, "tree");
  const entries = parseGitTree((await read(oid, "tree")).payload);
  const prior: Map<string, GitTreeEntry>[] = [];
  for (const tree of previous) prior.push(new Map(parseGitTree((await read(tree, "tree")).payload).map(entry => [entry.name, entry])));
  for (const entry of entries) {
    const old = prior.map(tree => tree.get(entry.name));
    if (old.some(other => other?.oid === entry.oid) || entry.mode === "160000" || skip.has(entry.oid)) continue;
    if (entry.mode === "40000") {
      await collectTree(read, objects, entry.oid, old.flatMap(other => other?.mode === "40000" ? [other.oid] : []), skip);
    } else addObject(objects, entry.oid, "blob", oid);
  }
}

/** A pack of `objects`. */
function packObjects(cache: GitReads, objects: PackObjects): ReadableStream<Uint8Array> {
  async function* contents() {
    for (const [oid, hint] of objects) yield await cache.packEntry(oid, {type: hint.type, referencedBy: hint.referencedBy});
  }
  return buildPackStream(objects.size, contents());
}

/**
 * Serve a fetch of history beyond the workspace's own commits from a connection: the commits in
 * `remoteWants`, once it confirms they are in the worktree's history, plus the boundary commits
 * in `bases`, of which the client has `has`, and/or more history beyond them, which the client's
 * wants reach at `depth` (undefined if not wanted). The confirmation trusts the connection: the
 * data it protects is the connection's own repository.
 */
async function proxyFetch(source: WorktreeGitSource, fetch: FetchRequest, remoteWants: string[], bases: string[],
    has: string[], depth: number | undefined): Promise<RemotePack> {
  let cause: unknown;
  let refused = false;
  for (const remote of remotesWith(source, bases)) {
    try {
      if (remoteWants.length && !await reachableFromHaves(remote, remoteWants)) {
        // A connection is only asked about the boundary commits it has provenance for, so
        // another connection may still find the commits reachable from its own.
        refused = true;
        continue;
      }
      const history = fetch.commitHistory;
      return await remote.pull([...remoteWants, ...bases], {
        type: "commit",
        commitHistory: history.kind === "depth" && depth !== undefined && !remoteWants.length && history.depth < INFINITE_DEPTH
          // An absolute depth counts from the client's wants, which the connection doesn't have.
          ? {kind: "depth", depth: history.depth - depth + 1}
          : history,
        haves: [...new Set([...fetch.haves, ...has])],
        shallow: fetch.shallow,
        filterBlobSize: fetch.filterBlobSize,
        filterTreeDepth: fetch.filterTreeDepth,
      });
    } catch (error) {
      cause = error;
    }
  }
  if (refused) throw new Error("Only commits in the worktree's history can be fetched.");
  throw new Error("No connected repository could serve these commits.", {cause});
}

/** Pull the boundary commits in `bases`, with their files, at depth 1 from a connection. */
async function pullBoundary(source: WorktreeGitSource, bases: string[]): Promise<RemotePack> {
  let cause: unknown;
  for (const remote of remotesWith(source, bases)) {
    try {
      return await remote.pull(bases, {type: "commit", commitHistory: {kind: "depth", depth: 1}});
    } catch (error) {
      cause = error;
    }
  }
  throw new Error("No connected repository could supply the worktree's files.", {cause});
}

/**
 * The connections that have every one of the boundary commits in `bases`. Those are pulled in
 * one request to one connection: packs from several couldn't be merged, since they may hold
 * some of the same objects, which Git rejects.
 */
function remotesWith(source: WorktreeGitSource, bases: string[]): WorktreeGitSource["remotes"] {
  const remotes = source.remotes.filter(remote => bases.every(oid => remote.haves.includes(oid)));
  if (bases.length && !remotes.length) {
    throw new Error("The worktree's history comes from several connected repositories, and none of them " +
      "has all of it, so it can't be fetched.");
  }
  return remotes;
}

/**
 * Ask a connection whether every commit in `wants` is reachable from its `haves`: a commit-only
 * fetch of `wants` that claims to have `haves` returns an empty pack exactly when there is
 * nothing in `wants`' history the client lacks.
 */
async function reachableFromHaves(remote: WorktreeGitSource["remotes"][number], wants: string[]): Promise<boolean> {
  const {pack} = await remote.pull(wants, {type: "commit", commitHistory: {kind: "full"}, filterTreeDepth: 0,
    haves: remote.haves});
  const reader = pack.getReader();
  try {
    const header = new Uint8Array(12);
    let filled = 0;
    while (filled < 12) {
      const next = await reader.read();
      if (next.done) throw new Error("Truncated Git pack header.");
      const count = Math.min(12 - filled, next.value.length);
      header.set(next.value.subarray(0, count), filled);
      filled += count;
    }
    return new DataView(header.buffer).getUint32(8) === 0;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
