// Serve native Git's read-only smart-HTTP fetch (protocol v2) from a mounted worktree, so that a
// container gatekeeper can point a Git remote at a made-up URL and forward the requests
// `git fetch` makes to `serveGitUploadPack()`. The worktree's Git API is structured
// (`WorktreeReplicator.gitHead()` and `gitPull()`); this translates between the two.

import type { GitPullTransfer } from "@gadgets/workshop-shared/gatekeeper";
import type { WorktreeGitPullHints, WorktreeReplicator } from "@gadgets/workshop-shared/worktree-replica";
import { DELIM_PKT, encodePktLine, FLUSH_PKT, parsePktItems, pktText, type PktItem } from "./git-transport";
import { readBytesCapped } from "./response-body";

/** What `serveGitUploadPack()` serves: a WorktreeReplicator, or anything with the same Git methods. */
export type GitUploadPackSource = Pick<WorktreeReplicator, "gitHead" | "gitPull">;

/** The largest fetch request accepted: each `have` line is about 50 bytes. */
const MAX_REQUEST_BYTES = 1024 * 1024;

/** Sideband data per packet: pkt-lines have a 16-bit length, including the header and band byte. */
const MAX_SIDEBAND_DATA = 65515;

/**
 * Answer one of native Git's smart-HTTP requests (protocol v2, read-only) from `source`. The
 * request's URL path must be exactly `/info/refs?service=git-upload-pack` (GET) or
 * `/git-upload-pack` (POST), so strip the made-up remote's own path first; the host is ignored.
 * Requests must carry the `Git-Protocol: version=2` header (run Git with `-c protocol.version=2`
 * if it isn't the default). Other requests are answered with HTTP 400. The repository has one
 * branch, `refs/heads/worktree`, which HEAD points to.
 *
 * An error from `source` is sent to Git as a remote error, which it prints, including one that
 * ends the pack partway (whose message `GitPullTransfer.status()` recovers).
 */
export async function serveGitUploadPack(request: Request, source: GitUploadPackSource): Promise<Response> {
  let path: "info/refs" | "git-upload-pack";
  let items: PktItem[];
  try {
    path = requestPath(request);
    items = path === "info/refs" ? [] : parsePktItems(await readBytesCapped(request, MAX_REQUEST_BYTES));
  } catch (error) {
    return new Response(message(error), {status: 400});
  }
  if (path === "info/refs") {
    return response("advertisement", [
      encodePktLine("version 2"), encodePktLine("ls-refs"), encodePktLine("fetch=shallow filter"), FLUSH_PKT,
    ]);
  }
  try {
    const lines = items.flatMap(item => item.kind === "data" ? [pktText(item.data)] : []);
    if (lines.includes("command=ls-refs")) {
      const head = await source.gitHead();
      return response("result", [
        encodePktLine(`${head} HEAD symref-target:refs/heads/worktree`),
        encodePktLine(`${head} refs/heads/worktree`), FLUSH_PKT,
      ]);
    }
    if (!lines.includes("command=fetch")) throw new Error("Only Git ls-refs and fetch are supported.");
    const fetch = parseFetch(items);
    const transfer = await source.gitPull(fetch.wants, fetch.hints);
    try {
      return fetchResponse(fetch.done, transfer, await transfer.shallowInfo(), await transfer.stream());
    } catch (error) {
      dispose(transfer);
      throw error;
    }
  } catch (error) {
    // Git dies with "remote error: <message>" on an ERR packet.
    return response("result", [encodePktLine(`ERR ${message(error)}`)]);
  }
}

/** Which of the two requests `request` is; throws for anything else. */
function requestPath(request: Request): "info/refs" | "git-upload-pack" {
  const url = new URL(request.url);
  if (request.headers.get("git-protocol") !== "version=2") throw new Error("Git protocol version 2 is required.");
  if (request.method === "GET" && url.pathname === "/info/refs" && url.search === "?service=git-upload-pack")
    return "info/refs";
  if (request.method === "POST" && url.pathname === "/git-upload-pack" && !url.search &&
      request.headers.get("content-type") === "application/x-git-upload-pack-request") return "git-upload-pack";
  throw new Error("Only Git ref discovery and fetch are allowed.");
}

/**
 * Parse a fetch command into a pull, accepting only the capabilities and arguments the pull can
 * express. `done` says whether the client finished negotiating.
 */
function parseFetch(items: PktItem[]): {wants: string[]; hints: WorktreeGitPullHints; done: boolean} {
  const delim = items.findIndex(item => item.kind === "delim");
  const text = (from: number, to: number) => items.slice(from, to)
    .flatMap(item => item.kind === "data" ? [pktText(item.data)] : []);
  for (const line of text(0, delim < 0 ? items.length : delim)) {
    if (line === "command=fetch" || line === "object-format=sha1" || /^(agent|session-id)=/.test(line)) continue;
    throw new Error(`Unsupported Git fetch capability: ${line.split("=")[0]}`);
  }
  const wants: string[] = [];
  const hints: WorktreeGitPullHints & {haves: string[]; shallow: string[]} =
    {commitHistory: {kind: "full"}, haves: [], shallow: []};
  let done = false;
  let deepen: {kind: "depth" | "since"; value: number} | undefined;
  let relative = false;
  const setDeepen = (kind: "depth" | "since", value: string) => {
    if (deepen) throw new Error("Only one Git deepen option is supported.");
    deepen = {kind, value: number(value)};
  };
  for (const line of text(delim < 0 ? items.length : delim + 1, items.length)) {
    const [keyword, value = ""] = line.split(/ (.*)/s);
    if (keyword === "want") wants.push(oid(value));
    else if (keyword === "have") hints.haves.push(oid(value));
    else if (keyword === "shallow") hints.shallow.push(oid(value));
    else if (keyword === "deepen") setDeepen("depth", value);
    else if (keyword === "deepen-since") setDeepen("since", value);
    else if (line === "deepen-relative") relative = true;
    else if (keyword === "filter") {
      const limit = /^blob:limit=(\d{1,15})$/.exec(value);
      if (value === "blob:none") hints.filterBlobSize = 0;
      else if (limit) hints.filterBlobSize = Number(limit[1]);
      else if (value === "tree:0") hints.filterTreeDepth = 0;
      else throw new Error("Unsupported Git fetch filter.");
    } else if (line === "done") done = true;
    // Harmless: this server never sends thin packs, tags or progress.
    else if (["ofs-delta", "thin-pack", "no-progress", "include-tag"].includes(line)) continue;
    else throw new Error(`Unsupported Git fetch argument: ${keyword}`);
  }
  if (relative && deepen?.kind !== "depth") throw new Error("deepen-relative requires a depth.");
  if (deepen?.kind === "depth") hints.commitHistory = {kind: relative ? "relative" : "depth", depth: deepen.value};
  else if (deepen) hints.commitHistory = {kind: "since", since: new Date(deepen.value * 1000)};
  if (!wants.length) throw new Error("Git fetch wants nothing.");
  return {wants, hints, done};
}

function oid(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("Invalid object ID in Git fetch.");
  return value;
}

function number(value: string): number {
  if (!/^\d{1,10}$/.test(value)) throw new Error("Invalid number in Git fetch.");
  return Number(value);
}

/**
 * The response to a fetch: the transfer's shallow boundary and pack. A fetch the client hasn't
 * finished negotiating is answered at once, as if it had (`ready`): the pull already left out
 * what the `have`s sent so far reach, so negotiation takes a single round.
 */
function fetchResponse(done: boolean, transfer: GitPullTransfer,
    shallow: {shallow: string[]; unshallow: string[]}, pack: ReadableStream<Uint8Array>): Response {
  const reader = pack.getReader();
  let released = false;
  // Release the pack and the transfer, once: at the end, or when Git disconnects, even before the
  // response was read or while a read is pending.
  const release = () => {
    if (released) return;
    released = true;
    reader.cancel().catch(() => {});
    dispose(transfer);
  };
  async function* result() {
    try {
      if (!done) {
        yield encodePktLine("acknowledgments");
        yield encodePktLine("ready");
        yield DELIM_PKT;
      }
      if (shallow.shallow.length || shallow.unshallow.length) {
        yield encodePktLine("shallow-info");
        for (const oid of shallow.shallow) yield encodePktLine(`shallow ${oid}`);
        for (const oid of shallow.unshallow) yield encodePktLine(`unshallow ${oid}`);
        yield DELIM_PKT;
      }
      yield encodePktLine("packfile");
      for (;;) {
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await reader.read();
        } catch (error) {
          // RPC may have replaced the producer's error; its status keeps the original.
          const status = await transfer.status().catch(() => undefined);
          yield sideband(3, new TextEncoder().encode(status?.state === "failed" ? status.message : message(error)));
          return;
        }
        if (next.done) break;
        for (let offset = 0; offset < next.value.length; offset += MAX_SIDEBAND_DATA)
          yield sideband(1, next.value.subarray(offset, offset + MAX_SIDEBAND_DATA));
      }
      yield FLUSH_PKT;
    } finally {
      release();
    }
  }
  const iterator = result();
  return new Response(new ReadableStream({
    type: "bytes",
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close(); else controller.enqueue(next.value.slice());
    },
    cancel() {
      release();
      // Ends the generator once a pending read returns, which cancelling the reader made it do.
      iterator.return(undefined).catch(() => {});
    },
  }, {highWaterMark: 0}), {headers: {"content-type": "application/x-git-upload-pack-result"}});
}

/** One sideband packet: band 1 carries the pack, band 3 a fatal error. */
function sideband(band: 1 | 3, data: Uint8Array): Uint8Array {
  const packet = new Uint8Array(data.length + 5);
  packet.set(new TextEncoder().encode(packet.length.toString(16).padStart(4, "0")));
  packet[4] = band;
  packet.set(data, 5);
  return packet;
}

function response(kind: "advertisement" | "result", lines: Uint8Array[]): Response {
  return new Response(new Blob(lines), {headers: {"content-type": `application/x-git-upload-pack-${kind}`}});
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Release `transfer` if it is a stub (a local one has nothing to release). */
function dispose(transfer: GitPullTransfer): void {
  (transfer as Partial<Disposable>)[Symbol.dispose]?.();
}
