import {encodePktLine, FLUSH_PKT, DELIM_PKT, gitPullPath, parsePktItems, pktText}
  from "@gadgets/gatekeeper-kit/git-transport";
import {readBytesCapped} from "@gadgets/gatekeeper-kit/response-body";
import {buildPackStream, mergePackStreams} from "./git-codec";
import {replicaCommitPack} from "./replica-git";
import type {WorkspaceGitCache} from "./git-cache";
import type {FileChangeByPath} from "@gadgets/workshop-shared/agent-integration";

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
   * worktree's base commit (`pinBase`) and the bases replicas have been told about.
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

  /** Throws if access has ended (e.g. the chat or connection was removed). Called repeatedly. */
  check(): void;

  /** Streams the raw pack (no protocol framing) for `shallowCommit`, at depth 1. */
  upstream(): Promise<ReadableStream<Uint8Array>>;

  /**
   * Forwards a fetch for objects the workspace doesn't have (e.g. another commit of the
   * connected repository) to that repository's connection. Absent if there is none.
   */
  remotePull?(request: Request): Promise<Response>;
}

/**
 * Serve Git smart-HTTP requests (protocol v2) for one worktree; see `WorktreeIntegration.gitPull()`.
 * The worktree's own commits are built from workspace storage, while the base commit's files
 * from a connected repository are streamed through from the provider rather than loaded into
 * the workspace.
 */
export async function worktreeGitPull(cache: Pick<WorkspaceGitCache, "ensureObject">, source: WorktreeGitSource,
    request: Request): Promise<Response> {
  const path = gitPullPath(request);
  source.check();
  const response = (lines: Uint8Array[]) => new Response(new Blob(lines), {headers: {
    "content-type": path.startsWith("info/") ? "application/x-git-upload-pack-advertisement" : "application/x-git-upload-pack-result",
  }});
  if (request.method === "GET") return response([
    encodePktLine("version 2"), encodePktLine("ls-refs"), encodePktLine("fetch=shallow"), FLUSH_PKT,
  ]);
  const body = await readBytesCapped(request, 1024 * 1024);
  source.check();
  const lines = parsePktItems(body).flatMap(item => item.kind === "data" ? [pktText(item.data)] : []);
  if (lines.includes("command=ls-refs")) return response([
    encodePktLine(`${source.head} HEAD symref-target:refs/heads/worktree`),
    encodePktLine(`${source.head} refs/heads/worktree`), FLUSH_PKT,
  ]);
  if (!lines.includes("command=fetch")) throw new Error("Only Git ls-refs and fetch are supported.");
  const wants = lines.filter(line => line.startsWith("want ")).map(line => line.slice(5));
  const localHeads = new Set([source.head, ...source.localHeads ?? []]);
  const blobs = new Set(source.pending.flatMap(({change}) => "setBytes" in change ? [change.setBytes.oid] : []));
  if (!wants.length || wants.some(oid => !/^[0-9a-f]{40}$/.test(oid))) throw new Error("Invalid Git fetch wants.");
  if (wants.some(oid => !localHeads.has(oid) && !blobs.has(oid))) {
    if (!source.remotePull || wants.some(oid => localHeads.has(oid) || blobs.has(oid)))
      throw new Error("Fetch local and upstream objects in separate requests.");
    // The repository provider authorizes the same smart-HTTP request, including an exact
    // revision discovered by a build script after the initial worktree was mounted.
    return source.remotePull(new Request(request.url, {method: request.method, headers: request.headers, body}));
  }
  if (!lines.includes("done")) return response([encodePktLine("acknowledgments"), encodePktLine("NAK"), FLUSH_PKT]);
  let pack: ReadableStream<Uint8Array>;
  if (wants.some(oid => localHeads.has(oid))) {
    const local = await replicaCommitPack(cache, {baseCommit: source.shallowCommit, acceptedCommit: source.head, headCommit: wants.find(oid => localHeads.has(oid))},
      source.check, source.pending);
    pack = source.shallowCommit ? await mergePackStreams([await source.upstream(), local]) : local;
  } else {
    async function* objects() {
      for (const oid of new Set(wants)) {
        source.check();
        const object = await cache.ensureObject(oid, {type: "blob"});
        source.check();
        yield object;
      }
    }
    pack = buildPackStream(new Set(wants).size, objects());
  }
  const reader = pack.getReader();
  async function* result() {
    try {
      if (source.shallowCommit && wants.some(oid => localHeads.has(oid))) {
        yield encodePktLine("shallow-info");
        yield encodePktLine(`shallow ${source.shallowCommit}`);
        yield DELIM_PKT;
      }
      yield encodePktLine("packfile");
      for (;;) {
        source.check();
        const next = await reader.read();
        source.check();
        if (next.done) break;
        // Sideband packets have a 16-bit length, including their header and channel byte.
        for (let offset = 0; offset < next.value.length; offset += 65515) {
          const part = next.value.subarray(offset, offset + 65515);
          const packet = new Uint8Array(part.length + 5);
          packet.set(new TextEncoder().encode(packet.length.toString(16).padStart(4, "0")));
          packet[4] = 1; packet.set(part, 5);
          source.check();
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
