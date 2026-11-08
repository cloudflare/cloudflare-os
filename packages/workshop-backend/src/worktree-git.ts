import {encodePktLine, FLUSH_PKT, DELIM_PKT, gitPullPath, parsePktItems, pktText} from "@gadgets/gatekeeper-kit/git-transport";
import {readBytesCapped} from "@gadgets/gatekeeper-kit/response-body";
import type {GitObjectType, GitPullHints, GitShallowInfo} from "@gadgets/workshop-shared/gatekeeper";
import {buildPackStream, mergePackStreams, parseGitCommitRefs, parseGitTree, readGitCommitHeader} from "./git-codec";
import type {WorkspaceGitCache} from "./git-cache";
import type {FileChangeByPath} from "@gadgets/workshop-shared/worktree-replica";

/**
 * What `worktreeGitPull()` needs to know about one worktree, supplied by the overseer. The
 * overseer decides where each object comes from; the client (e.g. Git in a container) only ever
 * sees one smart-HTTP repository.
 */
export interface WorktreeGitSource {
  /** The worktree's latest commit (WorktreeRecord.headCommit): advertised as HEAD. */
  head: string;

  /**
   * Other commits stored in the workspace that a client may fetch by ID, besides `head`: the
   * worktree's base commit (`pinBase`) and the commits replicas have been told about.
   */
  localHeads?: string[];

  /**
   * For a worktree that came from a connected repository, the commit it was created at: the
   * history boundary, as in a shallow clone. Its objects are streamed from `upstream()`, not
   * read from the workspace. Null when all of the worktree's history is in the workspace.
   */
  shallowCommit: string | null;

  /**
   * Uncommitted edits replicas may still need. Only their `setBytes` blob references matter:
   * those blobs may be fetched by ID.
   */
  pending: FileChangeByPath[];

  /** Throws if access has ended (e.g. the worktree or its chat was deleted). Called repeatedly. */
  check(): void;

  /** Streams the raw pack (no protocol framing) for `shallowCommit`, at depth 1. */
  upstream(): Promise<ReadableStream<Uint8Array>>;

  /**
   * Connections that can serve the part of `head`'s history beyond the workspace's own commits,
   * for a fetch of commits the workspace doesn't have (e.g. a build script running
   * `git fetch --depth=1 origin <sha>`) or of more history (`git fetch --deepen`). `haves` are
   * the history's boundary commits this connection is known to have; `pull` is its
   * `Gatekeeper.gitPull()`.
   */
  remotes: {haves: string[]; pull(oids: string[], hints: GitPullHints): Promise<RemotePack>}[];
}

/** A pack pulled from a connection, and the shallow boundary it reported. */
export interface RemotePack {
  pack: ReadableStream<Uint8Array>;
  shallow: GitShallowInfo;
}

/** The parts of a protocol-v2 `fetch` request that `worktreeGitPull()` understands. */
interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen?: {kind: "depth"; depth: number} | {kind: "relative"; depth: number} | {kind: "since"; since: number};
  filter: Pick<GitPullHints, "filterBlobSize" | "filterTreeDepth">;
  done: boolean;
}

/** Git's depth for "all history", as sent by `git fetch --unshallow`. */
const INFINITE_DEPTH = 0x7fffffff;

/**
 * Serve Git smart-HTTP requests (protocol v2) for one worktree; see `ReplicableWorktree.gitPull()`.
 * The worktree's own commits are built from workspace storage, while the base commit's files
 * from a connected repository are streamed through from the provider rather than loaded into
 * the workspace. History beyond the base is proxied from a connected repository.
 */
export async function worktreeGitPull(cache: Pick<WorkspaceGitCache, "ensureObject">, source: WorktreeGitSource,
    request: Request): Promise<Response> {
  const path = gitPullPath(request);
  source.check();
  const response = (lines: Uint8Array[]) => new Response(new Blob(lines), {headers: {
    "content-type": path.startsWith("info/") ? "application/x-git-upload-pack-advertisement" : "application/x-git-upload-pack-result",
  }});
  if (request.method === "GET") return response([
    encodePktLine("version 2"), encodePktLine("ls-refs"), encodePktLine("fetch=shallow filter"), FLUSH_PKT,
  ]);
  const body = await readBytesCapped(request, 1024 * 1024);
  source.check();
  const items = parsePktItems(body);
  const lines = items.flatMap(item => item.kind === "data" ? [pktText(item.data)] : []);
  if (lines.includes("command=ls-refs")) return response([
    encodePktLine(`${source.head} HEAD symref-target:refs/heads/worktree`),
    encodePktLine(`${source.head} refs/heads/worktree`), FLUSH_PKT,
  ]);
  if (!lines.includes("command=fetch")) throw new Error("Only Git ls-refs and fetch are supported.");
  const fetch = parseFetch(items);

  // Decide by what the client lacks, not by what it names: e.g. `git fetch --deepen=1` wants
  // the head the client already has, and lacks only history beyond the shallow boundary.
  const history = await localHistory(cache, source);
  const blobs = new Set(source.pending.flatMap(({change}) => "setBytes" in change ? [change.setBytes.oid] : []));
  const has = commonHistory(history, source.shallowCommit, fetch.haves);
  // The client only has the base's files if it has some commit in the history and is not
  // shallower than the base.
  const hasBase = has.size > 0 && !fetch.shallow.some(oid => history.has(oid));
  const localWants = fetch.wants.filter(oid => history.has(oid) || oid === source.shallowCommit || blobs.has(oid));
  const remoteWants = fetch.wants.filter(oid => !localWants.includes(oid));
  // The base's own objects are remote ones (streamed from `upstream()`), so a connection can
  // serve them too.
  const needsLocal = localWants.some(oid => history.has(oid) ? !has.has(oid) : oid !== source.shallowCommit);
  const depth = source.shallowCommit ? baseDepth(history, source.shallowCommit, localWants) : undefined;
  const deeper = depth !== undefined && await wantsDeeperHistory(cache, source.shallowCommit!, depth, fetch);
  if (remoteWants.length || deeper) {
    // Serving this would mean merging a local pack with a proxied one that may contain some of
    // the same objects, which Git rejects; see plans/git-proxy.md. A replica that fetches each
    // new head as it is told about it never needs both.
    if (needsLocal) {
      throw new Error("This fetch needs both new commits from the workspace and older history from the " +
        "connected repository. Fetch the worktree's head first, then fetch again.");
    }
    const base = deeper || localWants.includes(source.shallowCommit!);
    return proxyFetch(source, fetch, remoteWants, base, deeper ? depth : undefined, has.size > 0);
  }

  let pack: ReadableStream<Uint8Array>;
  let shallow: GitShallowInfo | undefined;
  const commits = localWants.filter(oid => history.has(oid) || oid === source.shallowCommit);
  if (commits.length) {
    const local = await localPack(cache, source.shallowCommit, commits, [...has], source.check, source.pending);
    if (source.shallowCommit && !hasBase) {
      pack = await mergePackStreams([await source.upstream(), local]);
      shallow = {shallow: [source.shallowCommit], unshallow: []};
    } else {
      pack = local;
    }
  } else {
    const wanted = new Set(localWants);
    async function* objects() {
      for (const oid of wanted) {
        source.check();
        const object = await cache.ensureObject(oid, {type: "blob"});
        source.check();
        yield object;
      }
    }
    pack = buildPackStream(wanted.size, objects());
  }
  return fetchResponse(!fetch.done, shallow, pack, source.check);
}

/**
 * Parse a fetch command, accepting only the capabilities and arguments `worktreeGitPull()`
 * understands. Anything sent on to a connection is re-encoded from the result, never forwarded
 * as is.
 */
function parseFetch(items: ReturnType<typeof parsePktItems>): FetchRequest {
  const delim = items.findIndex(item => item.kind === "delim");
  const text = (from: number, to: number) => items.slice(from, to)
    .flatMap(item => item.kind === "data" ? [pktText(item.data)] : []);
  for (const line of text(0, delim < 0 ? items.length : delim)) {
    if (line === "command=fetch" || line === "object-format=sha1" || /^(agent|session-id)=/.test(line)) continue;
    throw new Error(`Unsupported Git fetch capability: ${line.split("=")[0]}`);
  }
  const fetch: FetchRequest = {wants: [], haves: [], shallow: [], filter: {}, done: false};
  let relative = false;
  const oid = (value: string) => {
    if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("Invalid object ID in Git fetch.");
    return value;
  };
  const number = (value: string) => {
    if (!/^\d{1,10}$/.test(value)) throw new Error("Invalid number in Git fetch.");
    return Number(value);
  };
  const setDeepen = (deepen: FetchRequest["deepen"]) => {
    if (fetch.deepen) throw new Error("Only one Git deepen option is supported.");
    fetch.deepen = deepen;
  };
  for (const line of text(delim < 0 ? items.length : delim + 1, items.length)) {
    const [keyword, value = ""] = line.split(/ (.*)/s);
    if (keyword === "want") fetch.wants.push(oid(value));
    else if (keyword === "have") fetch.haves.push(oid(value));
    else if (keyword === "shallow") fetch.shallow.push(oid(value));
    else if (keyword === "deepen") setDeepen({kind: "depth", depth: number(value)});
    else if (keyword === "deepen-since") setDeepen({kind: "since", since: number(value)});
    else if (line === "deepen-relative") relative = true;
    else if (keyword === "filter") {
      const limit = /^blob:limit=(\d{1,15})$/.exec(value);
      if (value === "blob:none") fetch.filter = {filterBlobSize: 0};
      else if (limit) fetch.filter = {filterBlobSize: Number(limit[1])};
      else if (value === "tree:0") fetch.filter = {filterTreeDepth: 0};
      else throw new Error("Unsupported Git fetch filter.");
    } else if (line === "done") fetch.done = true;
    // Harmless: this server never sends thin packs, tags or progress.
    else if (["ofs-delta", "thin-pack", "no-progress", "include-tag"].includes(line)) continue;
    else throw new Error(`Unsupported Git fetch argument: ${keyword}`);
  }
  if (relative) {
    if (fetch.deepen?.kind !== "depth") throw new Error("deepen-relative requires a depth.");
    fetch.deepen = {kind: "relative", depth: fetch.deepen.depth};
  }
  if (!fetch.wants.length) throw new Error("Git fetch wants nothing.");
  return fetch;
}

/**
 * The workspace-stored commits of the history served: everything reachable from the worktree's
 * head and other local heads, back to (not including) `shallowCommit`. Maps each commit to its
 * parents.
 */
async function localHistory(cache: Pick<WorkspaceGitCache, "ensureObject">, source: WorktreeGitSource): Promise<Map<string, string[]>> {
  const history = new Map<string, string[]>();
  const stack = [source.head, ...source.localHeads ?? []];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === source.shallowCommit || history.has(oid)) continue;
    source.check();
    const commit = parseGitCommitRefs((await cache.ensureObject(oid, {type: "commit"})).payload);
    source.check();
    history.set(oid, commit.parents);
    if (history.size > 100_000) throw new Error("Worktree history exceeds its object budget.");
    stack.push(...commit.parents);
  }
  return history;
}

/**
 * The commits of `history`, plus `shallowCommit`, that the client has: those reachable from its
 * `haves`. Each `have` claims the commit's whole history, down to the client's shallow boundary.
 */
function commonHistory(history: Map<string, string[]>, shallowCommit: string | null, haves: string[]): Set<string> {
  const has = new Set<string>();
  const stack = haves.filter(oid => history.has(oid) || oid === shallowCommit);
  while (stack.length) {
    const oid = stack.pop()!;
    if (has.has(oid)) continue;
    has.add(oid);
    stack.push(...history.get(oid) ?? []);
  }
  return has;
}

/**
 * Whether a fetch of local commits, which reach `shallowCommit` at `depth`, asks for history
 * beyond it, which only a connection can serve: any relative deepen, an absolute depth reaching
 * past it, or a date no later than its commit time.
 */
async function wantsDeeperHistory(cache: Pick<WorkspaceGitCache, "ensureObject">, shallowCommit: string,
    depth: number, fetch: FetchRequest): Promise<boolean> {
  if (!fetch.deepen) return false;
  if (fetch.deepen.kind === "relative") return true;
  if (fetch.deepen.kind === "depth") return fetch.deepen.depth > depth;
  const commit = (await cache.ensureObject(shallowCommit, {type: "commit"})).payload;
  const time = /(\d+) [+-]\d{4}$/.exec(readGitCommitHeader(commit, "committer")[0] ?? "");
  return !time || Number(time[1]) >= fetch.deepen.since;
}

/** The depth (1 = the commit itself) at which `shallowCommit` is first reached from `wants`. */
function baseDepth(history: Map<string, string[]>, shallowCommit: string, wants: string[]): number | undefined {
  let level = [...new Set(wants)];
  const seen = new Set(level);
  for (let depth = 1; level.length; depth++) {
    if (level.includes(shallowCommit)) return depth;
    level = level.flatMap(oid => history.get(oid) ?? []).filter(oid => !seen.has(oid) && seen.add(oid));
  }
}

/**
 * Pack the workspace-stored history of `heads` back to `shallowCommit` (exclusive), plus the
 * blobs `pending` edits reference, leaving out the history of `haves`, which the client already
 * has. Objects in the base's tree are left out too: either the client has them, or the upstream
 * pack streamed alongside this one supplies them.
 */
async function localPack(cache: Pick<WorkspaceGitCache, "ensureObject">, shallowCommit: string | null,
    heads: string[], haves: string[], requireLive: () => void,
    pending: FileChangeByPath[]): Promise<ReadableStream<Uint8Array>> {
  const read = async (oid: string, type: GitObjectType, referencedBy?: string) => {
    requireLive();
    const object = await cache.ensureObject(oid, {type, referencedBy});
    requireLive();
    return object;
  };
  const baseTree = shallowCommit
    ? parseGitCommitRefs((await read(shallowCommit, "commit")).payload).tree : undefined;
  // Collect the objects of `commits`' history into `objects`, skipping anything in `skip`.
  const collect = async (commits: string[], objects: Map<string, {type: GitObjectType; referencedBy?: string}>,
      skip = new Map<string, unknown>()) => {
    const add = (oid: string, type: GitObjectType, referencedBy?: string) => {
      objects.set(oid, {type, referencedBy});
      if (objects.size > 100_000) throw new Error("Worktree history exceeds its object budget.");
    };
    const trees = async (oid: string, previous?: string) => {
      if (oid === previous || objects.has(oid) || skip.has(oid)) return;
      add(oid, "tree");
      const entries = parseGitTree((await read(oid, "tree")).payload);
      const prior = new Map(previous
        ? parseGitTree((await read(previous, "tree")).payload).map(entry => [entry.name, entry]) : []);
      for (const entry of entries) {
        const old = prior.get(entry.name);
        if (entry.oid === old?.oid || entry.mode === "160000" || skip.has(entry.oid)) continue;
        if (entry.mode === "40000") await trees(entry.oid, old?.mode === "40000" ? old.oid : undefined);
        else add(entry.oid, "blob", oid);
      }
    };
    const stack = [...new Set(commits)];
    while (stack.length) {
      const oid = stack.pop()!;
      if (oid === shallowCommit || objects.has(oid) || skip.has(oid)) continue;
      add(oid, "commit");
      const commit = parseGitCommitRefs((await read(oid, "commit")).payload);
      await trees(commit.tree, baseTree);
      stack.push(...commit.parents);
    }
  };
  const present = new Map<string, {type: GitObjectType; referencedBy?: string}>();
  await collect(haves, present);
  const objects = new Map<string, {type: GitObjectType; referencedBy?: string}>();
  await collect(heads, objects, present);
  for (const {change} of pending)
    if ("setBytes" in change && !present.has(change.setBytes.oid)) objects.set(change.setBytes.oid, {type: "blob"});
  // The base's files are supplied by the upstream pack or are already in the client. A
  // rename/copy can reuse a base blob at another path: same-path comparisons above alone cannot
  // prevent duplicate objects, which native Git rejects in a single combined pack. Inspect tree
  // metadata only; never fault a base blob into DO storage or retain the base's file contents in
  // memory.
  const excludeBase = async (oid: string) => {
    objects.delete(oid);
    for (const entry of parseGitTree((await read(oid, "tree")).payload)) {
      objects.delete(entry.oid);
      if (entry.mode === "40000") await excludeBase(entry.oid);
    }
  };
  if (baseTree && [...objects.values()].some(object => object.type !== "commit")) await excludeBase(baseTree);
  async function* contents() {
    for (const [oid, hint] of objects) yield await read(oid, hint.type, hint.referencedBy);
    requireLive();
  }
  return buildPackStream(objects.size, contents());
}

/**
 * Serve a fetch of history beyond the workspace's own commits from a connection: the commits in
 * `remoteWants`, once it confirms they are in the worktree's history, plus `shallowCommit` if
 * `base`, and/or more history beyond `shallowCommit`, which the client's wants reach at `depth`
 * (undefined if not wanted). The
 * confirmation trusts the connection: the data it protects is the connection's own repository.
 * `hasHistory` says the client has some of the worktree's history, so also the base: the
 * connection may leave out the history it knows the client has.
 */
async function proxyFetch(source: WorktreeGitSource, fetch: FetchRequest, remoteWants: string[], base: boolean,
    depth: number | undefined, hasHistory: boolean): Promise<Response> {
  const deeper = depth !== undefined;
  let cause: unknown;
  let refused = false;
  for (const remote of source.remotes) {
    if (base && !remote.haves.includes(source.shallowCommit!)) continue;
    try {
      if (remoteWants.length && !await reachableFromHaves(remote, remoteWants)) {
        // A connection is only asked about the boundary commits it has provenance for, so
        // another connection may still find the commits reachable from its own.
        refused = true;
        continue;
      }
      source.check();
      const result = await remote.pull([...remoteWants, ...base ? [source.shallowCommit!] : []], {
        type: "commit",
        commitHistory: !fetch.deepen ? {kind: "full"}
          : fetch.deepen.kind === "since" ? {kind: "since", since: new Date(fetch.deepen.since * 1000)}
          : fetch.deepen.kind === "depth" && deeper && !remoteWants.length && fetch.deepen.depth < INFINITE_DEPTH
          // An absolute depth counts from the client's wants, which the connection doesn't have.
          ? {kind: "depth", depth: fetch.deepen.depth - depth + 1}
          : fetch.deepen,
        haves: [...new Set([...fetch.haves, ...hasHistory ? remote.haves : []])],
        shallow: fetch.shallow,
        ...fetch.filter,
      });
      return fetchResponse(!fetch.done, result.shallow, result.pack, source.check);
    } catch (error) {
      cause = error;
    }
  }
  if (refused) throw new Error("Only commits in the worktree's history can be fetched.");
  throw new Error("No connected repository could serve these commits.", {cause});
}

/**
 * The response to a fetch: a pack and the client's new shallow boundary. A fetch the client
 * hasn't finished negotiating (`ready`) is answered at once, as if it had: the local path
 * already knows what to leave out from the `have`s sent so far, and a proxied fetch passes them
 * on, so that negotiation takes a single round.
 */
function fetchResponse(ready: boolean, shallow: GitShallowInfo | undefined, pack: ReadableStream<Uint8Array>,
    check: () => void): Response {
  const reader = pack.getReader();
  async function* result() {
    try {
      if (ready) {
        yield encodePktLine("acknowledgments");
        yield encodePktLine("ready");
        yield DELIM_PKT;
      }
      if (shallow?.shallow.length || shallow?.unshallow.length) {
        yield encodePktLine("shallow-info");
        for (const oid of shallow.shallow) yield encodePktLine(`shallow ${oid}`);
        for (const oid of shallow.unshallow) yield encodePktLine(`unshallow ${oid}`);
        yield DELIM_PKT;
      }
      yield encodePktLine("packfile");
      for (;;) {
        check();
        const next = await reader.read();
        check();
        if (next.done) break;
        // Sideband packets have a 16-bit length, including their header and channel byte.
        for (let offset = 0; offset < next.value.length; offset += 65515) {
          const part = next.value.subarray(offset, offset + 65515);
          const packet = new Uint8Array(part.length + 5);
          packet.set(new TextEncoder().encode(packet.length.toString(16).padStart(4, "0")));
          packet[4] = 1; packet.set(part, 5);
          check();
          yield packet;
        }
      }
      yield FLUSH_PKT;
    } finally { await reader.cancel(); reader.releaseLock(); }
  }
  const iterator = result();
  const stream = new ReadableStream({
    type: "bytes",
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close(); else controller.enqueue(next.value.slice());
    },
    async cancel() { await reader.cancel(); await iterator.return(undefined); },
  }, {highWaterMark: 0});
  return new Response(stream, {headers: {"content-type": "application/x-git-upload-pack-result"}});
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
