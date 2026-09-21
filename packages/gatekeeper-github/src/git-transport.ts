// Git smart-HTTP transport framing behind the GitHub gatekeeper's git operations (see github.ts):
//
// - The protocol v2 *fetch* client behind `Gatekeeper.gitPull()`: pkt-line framing, fetch-command
//   composition from `GitPullHints`, and sideband demultiplexing of the packfile response. The
//   raw pack body streams into `GitCache.consumePack()`, which decodes, hash-verifies, and
//   stores every object overseer-side.
// - The *send-pack* client behind the `push` action: the ref-update command block, pack body
//   composition (the pack bytes themselves come from `GitCache.buildPack()` -- no pack encoding
//   here either), and report-status response parsing.
//
// In both directions the gatekeeper handles only protocol framing and retains nothing locally.
//
// Two locked transport decisions (plans/worktrees.md) shape every request this module composes:
//
// - **No `have`s, ever.** A `have` asserts full reachability, but every pull here is filtered or
//   tree-limited, so possessing a commit never implies possessing its blobs and trees --
//   advertising one would make upload-pack exclude exactly the omitted objects a later
//   exact-object fault explicitly `want`s. Every fetch sends an empty have list and an immediate
//   `done` (the same noop negotiation stance git itself takes for partial-clone lazy fetches).
// - **At most one `filter` line per fetch.** upload-pack accepts a single filter-spec (a second
//   `filter` line is not merged; GitHub rejects the request), so combining hints is spelled in
//   the filter-spec grammar or not at all -- see `filterSpecForHints()`.
//
// Everything the composer relies on was verified against live GitHub upload-pack (spike 1 of
// plans/worktrees.md); the findings are documented on `filterSpecForHints()`.
//
// This module deliberately has no runtime imports (in particular no `cloudflare:workers`), so its
// logic runs under the package's Node vitest project.

import type { GitOid, GitPullHints } from "@gadgets/workshop-shared/gatekeeper";

/**
 * Maximum raw HTTP body size accepted from one upload-pack fetch, enforced while streaming (the
 * transfer-size limiter pattern from gatekeeper-context's artifact-sync, same 64MB budget --
 * also matching the cap the overseer's `consumePack()` applies to the pack itself).
 */
export const MAX_GIT_FETCH_BYTES = 64 << 20;

/** The `agent` capability sent with every request, mirroring the REST layer's User-Agent. */
const GIT_AGENT = "cloudflare-gadgets";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

// =======================================================================================
// pkt-line framing

/** A special (zero-payload) pkt or one data pkt, as produced by `PktLineParser`. */
export type PktItem =
  | { kind: "flush" }
  | { kind: "delim" }
  | { kind: "response-end" }
  | { kind: "data"; data: Uint8Array };

/** Flush-pkt ("0000"): terminates a request and the whole v2 response. */
export const FLUSH_PKT = new Uint8Array([0x30, 0x30, 0x30, 0x30]);

/** Delim-pkt ("0001"): separates a v2 command's capabilities from its arguments (and sections). */
export const DELIM_PKT = new Uint8Array([0x30, 0x30, 0x30, 0x31]);

/**
 * Encode one textual pkt-line: 4 hex length digits covering themselves, the payload, and the
 * conventional trailing newline git appends to textual lines.
 */
export function encodePktLine(line: string): Uint8Array {
  let payload = ENCODER.encode(line + "\n");
  let length = payload.byteLength + 4;
  if (length > 0xffff) throw new Error(`pkt-line too long: ${line.slice(0, 64)}...`);
  let out = new Uint8Array(length);
  out.set(ENCODER.encode(length.toString(16).padStart(4, "0")), 0);
  out.set(payload, 4);
  return out;
}

/**
 * Incremental pkt-line parser. `push()` accepts arbitrary chunk boundaries and returns the items
 * completed so far; `finish()` throws if bytes of an incomplete pkt remain. Defensive against
 * malformed input (a non-hex length or the meaningless length 3 is an error, not a skip), though
 * the input here always came from GitHub over TLS.
 */
export class PktLineParser {
  #chunks: Uint8Array[] = [];
  #offset = 0; // Consumed bytes of #chunks[0].
  #buffered = 0;

  push(chunk: Uint8Array): PktItem[] {
    if (chunk.byteLength > 0) {
      this.#chunks.push(chunk);
      this.#buffered += chunk.byteLength;
    }
    let items: PktItem[] = [];
    while (true) {
      let header = this.#peek(4);
      if (header === null) return items;
      let digits = DECODER.decode(header);
      if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
        throw new Error(`malformed pkt-line length: ${JSON.stringify(digits)}`);
      }
      let length = parseInt(digits, 16);
      if (length === 0) { this.#take(4); items.push({ kind: "flush" }); continue; }
      if (length === 1) { this.#take(4); items.push({ kind: "delim" }); continue; }
      if (length === 2) { this.#take(4); items.push({ kind: "response-end" }); continue; }
      if (length === 3) throw new Error("malformed pkt-line length: 0003");
      if (this.#buffered < length) return items;
      items.push({ kind: "data", data: this.#take(length).subarray(4) });
    }
  }

  finish(): void {
    if (this.#buffered > 0) {
      throw new Error("truncated pkt-line stream: input ended mid-pkt");
    }
  }

  #peek(n: number): Uint8Array | null {
    return this.#buffered < n ? null : this.#copy(n, false);
  }

  #take(n: number): Uint8Array {
    let out = this.#copy(n, true);
    if (out === null) throw new Error("pkt-line parser underflow");
    return out;
  }

  #copy(n: number, consume: boolean): Uint8Array | null {
    if (this.#buffered < n) return null;
    let out = new Uint8Array(n);
    let copied = 0;
    let index = 0;
    let offset = this.#offset;
    while (copied < n) {
      let chunk = this.#chunks[index];
      let available = chunk.byteLength - offset;
      let want = Math.min(available, n - copied);
      out.set(chunk.subarray(offset, offset + want), copied);
      copied += want;
      offset += want;
      if (offset === chunk.byteLength) { index += 1; offset = 0; }
    }
    if (consume) {
      this.#chunks.splice(0, index);
      this.#offset = offset;
      this.#buffered -= n;
    }
    return out;
  }
}

/** One-shot convenience over `PktLineParser` for complete buffers (used by tests). */
export function parsePktItems(data: Uint8Array): PktItem[] {
  let parser = new PktLineParser();
  let items = parser.push(data);
  parser.finish();
  return items;
}

/** Decode a data pkt's payload as text, stripping the conventional trailing newline. */
export function pktText(data: Uint8Array): string {
  let text = DECODER.decode(data);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

// =======================================================================================
// Fetch command composition

const OID_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Map `GitPullHints` to the single filter-spec this fetch sends, or undefined for none.
 *
 * The mapping is bounded by what GitHub's upload-pack actually supports, verified live (spike 1
 * of plans/worktrees.md):
 *
 * - `blob:none`, `blob:limit=<n>`, and `tree:0` are supported; `tree:<depth>` for any depth >= 1
 *   is rejected ("tree filter allows max depth 0"), and so is the `combine:` filter-spec grammar
 *   ("filter 'combine' not supported").
 * - Explicitly wanted objects are always delivered regardless of any filter (filters suppress
 *   only *traversed* objects) -- upstream git behaves the same way.
 *
 * Those two facts give each hint shape its best available spelling:
 *
 * - `filterTreeDepth` 0 or 1 → `tree:0`. Exact for both shapes the overseer sends: a commit want
 *   with depth 0 yields just the commit, and a tree want with depth 1 yields just the tree,
 *   because the wants themselves always arrive.
 * - `filterTreeDepth` >= 2 → `blob:none`. The depth is inexpressible on GitHub; this preserves
 *   the hint's no-blobs property at the cost of over-fetching subtree *structure*, which is
 *   consistent with trees being eager everywhere else.
 * - When `filterBlobSize` is set alongside `filterTreeDepth`, the tree mapping wins -- the
 *   plan's honor-only-the-tree-filter fallback for a transport that cannot combine. No fidelity
 *   is lost: both `tree:0` and `blob:none` already suppress every traversed blob, which is
 *   strictly stronger than any `blob:limit`.
 * - A fetch whose wants are themselves blobs (`hints.type === "blob"`) sends **no filter**: a
 *   blob want has no traversal for a filter to prune, and the filter would not suppress the
 *   wanted blob anyway -- an oversized blob arrives huge, the transfer limiter bounds the
 *   download, and the overseer's `put()`-equivalent size rejection measures and records its
 *   exact size (so later reads fail fast). This is the second of spike 1's two possible worlds;
 *   nothing is ever inferred from an absence.
 * - Otherwise `filterBlobSize` maps directly: 0 (fetch no blobs) → `blob:none`, N → `blob:limit=N`
 *   (git's semantics -- omit blobs of size at least N -- match the hint's).
 */
export function filterSpecForHints(hints: GitPullHints): string | undefined {
  if (hints.filterTreeDepth !== undefined) {
    return Math.floor(hints.filterTreeDepth) <= 1 ? "tree:0" : "blob:none";
  }
  if (hints.type === "blob") return undefined;
  if (hints.filterBlobSize !== undefined) {
    let limit = Math.max(0, Math.floor(hints.filterBlobSize));
    return limit === 0 ? "blob:none" : `blob:limit=${limit}`;
  }
  return undefined;
}

/**
 * Compose the protocol v2 `fetch` command request body for the given objects and hints: a `want`
 * per oid, shallow bounds from `commitHistory` (`deepen`/`deepen-since`; harmless alongside
 * non-commit wants, verified), at most one `filter` line (see `filterSpecForHints`), `ofs-delta`
 * (the overseer's pack decoder resolves both delta forms), and an immediate `done` with no
 * `have`s ever (the transport locked decision -- see the module doc).
 */
export function buildGitFetchRequest(oids: GitOid[], hints: GitPullHints): Uint8Array {
  let wants = [...new Set(oids)];
  if (wants.length === 0) throw new Error("git fetch requested no objects");
  for (let oid of wants) {
    if (!OID_PATTERN.test(oid)) throw new Error(`invalid git oid: ${JSON.stringify(oid)}`);
  }

  let args = wants.map(oid => `want ${oid}`);
  args.push("ofs-delta", "no-progress");
  let history = hints.commitHistory;
  if (history.kind === "depth") {
    args.push(`deepen ${Math.max(1, Math.floor(history.depth))}`);
  } else if (history.kind === "since") {
    args.push(`deepen-since ${Math.max(0, Math.floor(history.since.getTime() / 1000))}`);
  } // kind "full": no shallow bound.
  let filter = filterSpecForHints(hints);
  if (filter !== undefined) args.push(`filter ${filter}`);
  args.push("done");

  let pieces = [
    ...["command=fetch", `agent=${GIT_AGENT}`, "object-format=sha1"].map(encodePktLine),
    DELIM_PKT,
    ...args.map(encodePktLine),
    FLUSH_PKT,
  ];
  let out = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
  let offset = 0;
  for (let piece of pieces) {
    out.set(piece, offset);
    offset += piece.byteLength;
  }
  return out;
}

// =======================================================================================
// Response demultiplexing

const BAND_PACK = 1;
const BAND_PROGRESS = 2;
const BAND_ERROR = 3;

/**
 * Strip a v2 fetch response's protocol framing, yielding the raw pack bytes: skip the sections
 * preceding `packfile` (`acknowledgments`/`shallow-info`/`wanted-refs` -- their content is
 * irrelevant here, since every fetch is independent and nothing tracks shallow boundaries),
 * then demultiplex the packfile section's sideband (band 1 = pack data, band 2 = progress,
 * discarded, band 3 = fatal server error). An `ERR` pkt or band-3 message fails the stream with
 * the server's message; `maxBytes` bounds the raw body (see MAX_GIT_FETCH_BYTES); a response
 * that ends without a flush-pkt, or without ever reaching a packfile section, is an error --
 * a truncated pack must never look like a short success.
 */
export function demuxGitFetchResponse(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let iterator = demuxPackData(body, maxBytes);
  return new ReadableStream({
    async pull(controller) {
      let next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}

async function* demuxPackData(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): AsyncGenerator<Uint8Array, void, unknown> {
  let reader = body.getReader();
  try {
    let parser = new PktLineParser();
    let received = 0;
    let inPackfile = false;
    while (true) {
      let result = await reader.read();
      if (result.done) {
        parser.finish();
        throw new Error(inPackfile
            ? "truncated git fetch response: missing final flush"
            : "git fetch response contained no packfile section");
      }
      let value = result.value;
      received += value.byteLength;
      if (received > maxBytes) {
        throw new Error(`git fetch response exceeded the ${maxBytes}-byte transfer limit`);
      }
      for (let item of parser.push(value)) {
        if (item.kind === "delim" || item.kind === "response-end") continue;
        if (item.kind === "flush") {
          if (!inPackfile) {
            throw new Error("git fetch response contained no packfile section");
          }
          return;
        }
        if (!inPackfile) {
          let line = pktText(item.data);
          if (line.startsWith("ERR ")) {
            throw new Error(`git fetch failed: ${line.slice(4)}`);
          }
          if (line === "packfile") inPackfile = true;
          // Anything else is an earlier section's header or content line; skip it.
          continue;
        }
        // Sideband frame within the packfile section.
        if (item.data.byteLength === 0) throw new Error("malformed sideband frame: empty pkt");
        let band = item.data[0];
        let payload = item.data.subarray(1);
        if (band === BAND_PACK) {
          if (payload.byteLength > 0) yield payload;
        } else if (band === BAND_ERROR) {
          throw new Error(`git fetch failed: ${pktText(payload)}`);
        } else if (band !== BAND_PROGRESS) {
          throw new Error(`malformed sideband frame: unknown band ${band}`);
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// =======================================================================================
// Pull driver

/**
 * The one method of `GitCache` this module needs; structural so both an `RpcStub<GitCache>` and
 * a test fake satisfy it.
 */
export type GitPackSink = {
  consumePack(pack: ReadableStream<Uint8Array>): Promise<GitOid[]>;
};

/**
 * The whole of a `gitPull()`: compose the fetch command, POST it via the caller-supplied
 * transport (which owns the URL, auth, and HTTP-level error handling), strip the response's
 * protocol framing, stream the raw pack into `cache.consumePack()`, and verify every requested
 * oid is among the stored objects.
 *
 * One deliberate carve-out, mirroring the `Gatekeeper.gitPull()` contract: when the request was
 * a blob fetch bounded by the hints' own `filterBlobSize`, a requested blob missing from the
 * stored list is reported by returning successfully without it -- `consumePack()` measures,
 * records, and skips an object over the storable size cap (so later reads fail fast on the
 * recorded size), and the overseer surfaces the absence as its oversized-file read error.
 */
export async function pullGitObjectsIntoCache(
  fetchUploadPack: (requestBody: Uint8Array) => Promise<Response>,
  oids: GitOid[],
  hints: GitPullHints,
  cache: GitPackSink,
): Promise<void> {
  let response = await fetchUploadPack(buildGitFetchRequest(oids, hints));
  if (!response.ok) {
    // The transport normally throws its own richer error first (see GitHubApi); this is a
    // defensive backstop for transports that don't.
    await response.body?.cancel().catch(() => {});
    throw new Error(`git fetch failed: HTTP ${response.status}`);
  }
  if (response.body === null) {
    throw new Error("git fetch failed: response had no body");
  }
  let stored = new Set(await cache.consumePack(
      demuxGitFetchResponse(response.body, MAX_GIT_FETCH_BYTES)));
  let missing = oids.filter(oid => !stored.has(oid));
  if (missing.length > 0 && !(hints.type === "blob" && hints.filterBlobSize !== undefined)) {
    throw new Error(`git fetch did not provide the requested object${
        missing.length === 1 ? "" : "s"} ${missing.join(", ")}`);
  }
}

// =======================================================================================
// Send-pack (push)

/** The all-zeros oid: "no such ref" as a ref-update command's old (creation) or new (deletion). */
export const ZERO_OID = "0".repeat(40);

/**
 * Maximum size of a receive-pack response accepted before parsing. A report-status body is a
 * handful of pkt-lines; anything approaching this bound is not one.
 */
export const MAX_RECEIVE_PACK_RESPONSE_BYTES = 64 * 1024;

/** One ref update for `pushGitRefUpdate`. `branch` is a branch name, not a full refname. */
export type GitRefUpdate = {
  branch: string;
  /** The expected current value of the ref (`ZERO_OID` to require that it not exist). */
  oldSha: GitOid;
  /** The value to set (`ZERO_OID` to delete the ref). */
  newSha: GitOid;
};

/**
 * Validate a branch name against git's refname rules (the subset that matters for
 * `refs/heads/<branch>`), so a hostile name can neither escape the ref namespace (`..`, leading
 * `/`) nor corrupt the pkt-line framing (control bytes, spaces). Returns the name unchanged.
 */
export function validateBranchName(branch: string): string {
  if (branch.length === 0 || branch.length > 255) {
    throw new Error(`invalid branch name: ${JSON.stringify(branch.slice(0, 64))}`);
  }
  // One check for everything git forbids in a refname component, plus NUL/space/DEL and the
  // rest of the control range, which also covers the "@{", "..", and "//" sequences.
  // oxlint-disable-next-line no-control-regex -- intentionally rejecting control chars (protocol-framing guard)
  if (/[\u0000-\u0020\u007f~^:?*[\\]|\.\.|@\{|\/\/|\.\/|\.lock(\/|$)/.test(branch) ||
      branch.startsWith("/") || branch.endsWith("/") ||
      branch.startsWith(".") || branch.endsWith(".") ||
      branch.includes("/.") || branch === "@") {
    throw new Error(`invalid branch name: ${JSON.stringify(branch.slice(0, 64))}`);
  }
  return branch;
}

function validateOid(oid: GitOid): GitOid {
  if (!OID_PATTERN.test(oid)) throw new Error(`invalid git oid: ${JSON.stringify(oid)}`);
  return oid;
}

/**
 * Compose the ref-update command block of a send-pack request: one command pkt-line
 * (`<old> <new> refs/heads/<branch>` with the capability list after a NUL) and the terminating
 * flush-pkt. The pack itself follows this block in the request body (except for a pure
 * deletion, which must send no pack).
 *
 * Only `report-status` (and the `agent`) is requested: no side-band, so the response is a bare
 * report-status body (see `parseReceivePackResponse`), and no `delete-refs` is needed for the
 * one-command deletes revert issues (servers accept a zero-id new-sha regardless; GitHub
 * advertises the capability).
 */
export function buildRefUpdateRequest(update: GitRefUpdate): Uint8Array {
  validateOid(update.oldSha);
  validateOid(update.newSha);
  validateBranchName(update.branch);
  if (update.oldSha === update.newSha) {
    throw new Error("ref update is a no-op");
  }
  let command = `${update.oldSha} ${update.newSha} refs/heads/${update.branch}` +
      `\0report-status agent=${GIT_AGENT}`;
  let pieces = [encodePktLine(command), FLUSH_PKT];
  let out = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
  let offset = 0;
  for (let piece of pieces) {
    out.set(piece, offset);
    offset += piece.byteLength;
  }
  return out;
}

/**
 * A packfile containing zero objects: the 12-byte header plus its SHA-1 trailer. Sent when a
 * ref update transmits no new objects -- rolling a branch back to a commit the remote already
 * has -- since receive-pack still expects a pack for any non-delete command.
 */
export async function emptyPackBytes(): Promise<Uint8Array> {
  let header = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);  // "PACK", v2, 0
  let trailer = new Uint8Array(await crypto.subtle.digest("SHA-1", header));
  let out = new Uint8Array(header.byteLength + trailer.byteLength);
  out.set(header, 0);
  out.set(trailer, header.byteLength);
  return out;
}

/**
 * Parse a receive-pack report-status response (requested without side-band, so the body is bare
 * pkt-lines): `unpack ok` followed by one `ok <ref>` / `ng <ref> <reason>` per command. Returns
 * normally iff the update to `refName` succeeded; throws with the server's reason otherwise --
 * most importantly the old-sha compare-and-swap failure, which the caller maps to its
 * branch-moved error.
 */
export function parseReceivePackResponse(body: Uint8Array, refName: string): void {
  let unpackSeen = false;
  for (let item of parsePktItems(body)) {
    if (item.kind !== "data") continue;
    let line = pktText(item.data);
    if (line.startsWith("unpack ")) {
      unpackSeen = true;
      let status = line.slice("unpack ".length);
      if (status !== "ok") throw new Error(`git push failed: unpack error: ${status}`);
    } else if (line === `ok ${refName}`) {
      return;
    } else if (line.startsWith(`ng ${refName} `) || line === `ng ${refName}`) {
      let reason = line.slice(`ng ${refName}`.length).trim();
      throw new GitRefUpdateRejectedError(refName, reason || "rejected");
    }
    // Lines about other refs (there are none in our one-command requests) are ignored.
  }
  throw new Error(unpackSeen
      ? `git push failed: the server's status report did not mention ${refName}`
      : "git push failed: malformed receive-pack response (no unpack status)");
}

/**
 * The server rejected the ref-update command itself (the objects were fine): most commonly the
 * old-sha compare-and-swap failed because the branch moved (or appeared) between approval and
 * apply. Distinguished so the caller can map it to its branch-moved guidance.
 */
export class GitRefUpdateRejectedError extends Error {
  constructor(refName: string, public readonly reason: string) {
    super(`git push rejected for ${refName}: ${reason}`);
  }
}

/**
 * The whole of one push's wire exchange: compose the ref-update command block, splice the pack
 * behind it (no pack for a deletion -- the protocol forbids one when only deletes are sent),
 * POST it via the caller-supplied transport (which owns the URL, auth, and HTTP-level error
 * handling), and parse the report-status response. Resolves iff the server reports the update
 * applied; throws `GitRefUpdateRejectedError` when the command was rejected (e.g. the old-sha
 * CAS failed because the branch moved).
 */
export async function pushGitRefUpdate(
  fetchReceivePack: (requestBody: ReadableStream<Uint8Array>) => Promise<Response>,
  update: GitRefUpdate,
  pack: ReadableStream<Uint8Array> | null,
): Promise<void> {
  let header = buildRefUpdateRequest(update);
  if ((update.newSha === ZERO_OID) !== (pack === null)) {
    throw new Error(pack === null
        ? "a non-delete ref update requires a pack"
        : "a ref deletion must not send a pack");
  }

  let headerSent = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headerSent) {
        headerSent = true;
        controller.enqueue(header);
        return;
      }
      if (pack === null) {
        controller.close();
        return;
      }
      reader ??= pack.getReader();
      let { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      if (reader !== undefined) await reader.cancel(reason).catch(() => {});
      else await pack?.cancel(reason).catch(() => {});
    },
  });

  let response = await fetchReceivePack(body);
  if (!response.ok) {
    // Defensive backstop, as in pullGitObjectsIntoCache: the transport normally throws first.
    await response.body?.cancel().catch(() => {});
    throw new Error(`git push failed: HTTP ${response.status}`);
  }
  if (response.body === null) {
    throw new Error("git push failed: response had no body");
  }
  let report = await collectStream(response.body, MAX_RECEIVE_PACK_RESPONSE_BYTES);
  parseReceivePackResponse(report, `refs/heads/${update.branch}`);
}

// Collects a byte stream into one buffer, enforcing a size cap as chunks arrive.
async function collectStream(stream: ReadableStream<Uint8Array>, maxBytes: number)
    : Promise<Uint8Array> {
  let chunks: Uint8Array[] = [];
  let total = 0;
  let reader = stream.getReader();
  try {
    while (true) {
      let result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        throw new Error(`git push response exceeded the ${maxBytes}-byte limit`);
      }
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  let out = new Uint8Array(total);
  let offset = 0;
  for (let chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
