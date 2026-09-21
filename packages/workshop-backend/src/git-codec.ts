// Hand-rolled git object and packfile codec, used by the git cache (git-cache.ts).
//
// This is the *read-side* codec for the cache's lazy paths plus the pack codec for
// `GitCache.buildPack()`/`consumePack()`. It deliberately does not use isomorphic-git:
// - The lazy walker needs to parse objects it fetched by bare oid, attributing errors to the
//   object (e.g. a tree with a non-UTF-8 entry name must fail naming the tree), and to see all
//   five tree entry modes -- isomorphic-git's fs-shaped API fits neither well.
// - Pack *decoding* is hostile-input parsing (any gatekeeper can feed `consumePack()` anything),
//   so it must bound allocations and fail loudly. isomorphic-git's pack machinery is not
//   reachable from its exports map in 1.40 (verified), and the public `indexPack` route both
//   silently *skips* objects whose delta chain fails to resolve and trusts claimed sizes.
// isomorphic-git remains the engine for the existing full-materialization reads and all tree/
// commit *writes* (git-store.ts); tests cross-verify the two codecs over the same store.
//
// Everything here is pure computation over byte arrays: no storage, no RPC. zlib comes from pako
// (the same library isomorphic-git bundles) because pack entries are concatenated zlib streams
// with no recorded lengths -- finding where one ends requires a streaming inflater that reports
// unconsumed input, which DecompressionStream cannot do.

import { Inflate, deflate, inflate } from "pako";
import type { GitObjectType, GitOid } from "@gadgets/workshop-shared/gatekeeper";

const ENCODER = new TextEncoder();

/** Matches a full 40-hex SHA-1 git object name. */
const OID_REGEX = /^[0-9a-f]{40}$/;

/** Validates an externally-supplied oid before it is used as a storage key or in a walk. */
export function validateGitOid(oid: string): GitOid {
  if (!OID_REGEX.test(oid)) throw new Error(`Invalid git object id: ${JSON.stringify(oid)}`);
  return oid;
}

const GIT_OBJECT_TYPES: readonly GitObjectType[] = ["commit", "tree", "blob", "tag"];

/** Validates an externally-supplied object type string. */
export function validateGitObjectType(type: string): GitObjectType {
  if (!(GIT_OBJECT_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Invalid git object type: ${JSON.stringify(type)}`);
  }
  return type as GitObjectType;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Concatenates byte arrays. (Exported for git-cache's stream collection.) */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let pos = 0;
  for (let part of parts) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  return out;
}

// =======================================================================================
// Loose objects
//
// A loose object is zlib(`<type> <size>\0` + payload); its oid is the SHA-1 of the *inflated*
// whole. These helpers are the raw codec behind GitObjectRecord.data (see git-store.ts) --
// byte-compatible with what isomorphic-git reads and writes there, though the compressed bytes
// need not be bit-identical (the store is keyed by oid; readers inflate).

/** Computes the oid of an object from its type and headerless payload. */
export async function gitObjectOid(type: GitObjectType, payload: Uint8Array): Promise<GitOid> {
  let header = ENCODER.encode(`${type} ${payload.byteLength}\0`);
  let digest = await crypto.subtle.digest("SHA-1", concatBytes([header, payload]));
  return toHex(new Uint8Array(digest));
}

/** Encodes a loose object record's `data` bytes from a type and headerless payload. */
export function encodeLooseObject(type: GitObjectType, payload: Uint8Array): Uint8Array {
  let header = ENCODER.encode(`${type} ${payload.byteLength}\0`);
  return deflate(concatBytes([header, payload]));
}

/** Decodes a loose object record's `data` bytes into its type and headerless payload. */
export function decodeLooseObject(data: Uint8Array): { type: GitObjectType, payload: Uint8Array } {
  let whole: Uint8Array;
  try {
    whole = inflate(data);
  } catch (err) {
    throw new Error(`corrupt loose git object: ${String(err)}`, { cause: err });
  }
  let nul = whole.indexOf(0);
  if (nul < 0 || nul > 31) throw new Error("corrupt loose git object: missing header");
  let header = new TextDecoder().decode(whole.subarray(0, nul));
  let space = header.indexOf(" ");
  if (space < 0) throw new Error("corrupt loose git object: malformed header");
  let type = validateGitObjectType(header.slice(0, space));
  let size = Number(header.slice(space + 1));
  let payload = whole.subarray(nul + 1);
  if (!Number.isSafeInteger(size) || size !== payload.byteLength) {
    throw new Error("corrupt loose git object: header size does not match payload");
  }
  return { type, payload };
}

// =======================================================================================
// Tree objects
//
// A tree payload is a sequence of `<mode> <name>\0<20-byte oid>` entries. All five modes a real
// repo can contain are recognized; nothing else is (an unknown mode is a parse error, not a
// silent skip, so a misparse can never misattribute content).

/** The five tree entry modes git writes, exactly as serialized (no leading zero on trees). */
export type GitTreeEntryMode = "100644" | "100755" | "40000" | "120000" | "160000";

const TREE_ENTRY_MODES: readonly GitTreeEntryMode[] =
    ["100644", "100755", "40000", "120000", "160000"];

/** The object type a tree entry of the given mode references. */
export function treeEntryObjectType(mode: GitTreeEntryMode): GitObjectType {
  return mode === "40000" ? "tree" : mode === "160000" ? "commit" : "blob";
}

/**
 * A structurally-parsed tree entry whose name is still raw bytes. Produced by `scanGitTree()`,
 * which (unlike `parseGitTree()`) tolerates names that are not valid UTF-8 -- for callers that
 * only follow oids (referent recording, the push marking walk) and must not fail on a tree that
 * merely *contains* an exotic name.
 */
export interface RawGitTreeEntry {
  mode: GitTreeEntryMode;
  nameBytes: Uint8Array;
  oid: GitOid;
}

/** A fully-parsed tree entry. See `parseGitTree()` for the name decoding contract. */
export interface GitTreeEntry {
  mode: GitTreeEntryMode;
  name: string;
  oid: GitOid;
}

/** Parses a tree payload structurally, leaving entry names as raw bytes. */
export function scanGitTree(payload: Uint8Array, treeOid?: GitOid): RawGitTreeEntry[] {
  let where = treeOid ?? "(unidentified)";
  let entries: RawGitTreeEntry[] = [];
  let pos = 0;
  while (pos < payload.byteLength) {
    let space = payload.indexOf(0x20, pos);
    if (space < 0 || space - pos > 6) throw new Error(`corrupt tree object ${where}: bad mode`);
    let mode = new TextDecoder().decode(payload.subarray(pos, space));
    if (!(TREE_ENTRY_MODES as readonly string[]).includes(mode)) {
      throw new Error(`corrupt tree object ${where}: unsupported entry mode ${mode}`);
    }
    let nul = payload.indexOf(0, space + 1);
    if (nul < 0 || nul === space + 1) throw new Error(`corrupt tree object ${where}: bad name`);
    if (nul + 21 > payload.byteLength) {
      throw new Error(`corrupt tree object ${where}: truncated entry`);
    }
    entries.push({
      mode: mode as GitTreeEntryMode,
      nameBytes: payload.subarray(space + 1, nul),
      oid: toHex(payload.subarray(nul + 1, nul + 21)),
    });
    pos = nul + 21;
  }
  return entries;
}

/**
 * Parses a tree payload including entry names, which are decoded as *strict* UTF-8: an invalid
 * name fails the whole parse with an error naming the tree and the offending bytes. Strictness
 * is a correctness property, not pedantry -- a lossy decode (replacement characters) could alias
 * two distinct byte names to one string path, making an edit silently target the wrong entry,
 * whereas names that pass strict decode re-encode to their exact original bytes and can never
 * alias. Non-UTF-8 names are vanishingly rare in practice; if one is ever hit for real, decide
 * the accommodation then.
 */
export function parseGitTree(payload: Uint8Array, treeOid?: GitOid): GitTreeEntry[] {
  // ignoreBOM keeps a leading BOM as content: stripping it would make the decode lossy, which
  // is exactly the aliasing this strict decode exists to prevent.
  let decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  return scanGitTree(payload, treeOid).map(entry => {
    let name: string;
    try {
      name = decoder.decode(entry.nameBytes);
    } catch {
      throw new Error(
          `tree object ${treeOid ?? "(unidentified)"} contains an entry name that is not ` +
          `valid UTF-8 (bytes ${toHex(entry.nameBytes)}); such trees are not supported`);
    }
    return { mode: entry.mode, name, oid: entry.oid };
  });
}

// =======================================================================================
// Commit objects

/** The oids a commit object references. */
export interface GitCommitRefs {
  tree: GitOid;
  parents: GitOid[];
}

/**
 * Extracts the tree and parent oids from a commit payload. Only the header section (everything
 * before the first blank line) is examined; continuation lines (leading space, e.g. within a
 * `gpgsig` header) are skipped, and the message is never decoded.
 */
export function parseGitCommitRefs(payload: Uint8Array, commitOid?: GitOid): GitCommitRefs {
  let where = commitOid ?? "(unidentified)";
  let tree: GitOid | undefined;
  let parents: GitOid[] = [];
  let decoder = new TextDecoder();
  let pos = 0;
  while (pos < payload.byteLength) {
    let eol = payload.indexOf(0x0a, pos);
    if (eol < 0) eol = payload.byteLength;
    if (eol === pos) break;                    // blank line: end of headers
    if (payload[pos] !== 0x20) {               // skip continuation lines
      let line = decoder.decode(payload.subarray(pos, eol));
      if (line.startsWith("tree ")) {
        if (tree !== undefined) throw new Error(`corrupt commit object ${where}: multiple trees`);
        tree = validateGitOid(line.slice(5));
      } else if (line.startsWith("parent ")) {
        parents.push(validateGitOid(line.slice(7)));
      }
    }
    pos = eol + 1;
  }
  if (tree === undefined) throw new Error(`corrupt commit object ${where}: missing tree header`);
  return { tree, parents };
}

// =======================================================================================
// Packfiles
//
// Format: "PACK" + u32 version (2) + u32 object count, then per object a varint header
// ((type << 4) | size, MSB-continued) followed by a zlib stream of the payload -- or, for delta
// entries (ofs-delta / ref-delta), the base reference followed by a zlib stream of delta
// instructions -- and finally a SHA-1 trailer over everything before it.

/** One object carried by (or destined for) a packfile. */
export interface PackableObject {
  type: GitObjectType;
  payload: Uint8Array;
}

const PACK_TYPE_CODES: Partial<Record<GitObjectType, number>> =
    { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TYPES: Record<number, GitObjectType> =
    { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const OFS_DELTA = 6;
const REF_DELTA = 7;

// Delta chains in packs git produces are short (default depth 50); this is purely a defensive
// bound against a crafted pack forcing deep recursion.
const MAX_DELTA_DEPTH = 512;

/**
 * Composes an undeltified packfile (with the standard SHA-1 trailer) carrying the given objects,
 * as a chunk list ready to stream. Deltification and thin packs are future internals; every
 * receiver accepts whole objects. (Output format verified against real `git index-pack --strict`
 * + `git fsck` over the fixture repo, in addition to the round-trip tests.)
 */
export async function buildPackBytes(objects: readonly PackableObject[]): Promise<Uint8Array[]> {
  let chunks: Uint8Array[] = [];
  let header = new Uint8Array(12);
  header.set(ENCODER.encode("PACK"), 0);
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, objects.length);
  chunks.push(header);
  for (let object of objects) {
    let typeCode = PACK_TYPE_CODES[object.type];
    if (typeCode === undefined) throw new Error(`cannot pack object of type ${object.type}`);
    chunks.push(packEntryHeader(typeCode, object.payload.byteLength));
    chunks.push(deflate(object.payload));
  }

  chunks.push(new Uint8Array(await crypto.subtle.digest("SHA-1", concatBytes(chunks))));
  return chunks;
}

// Encodes a pack entry header: 4 bits of size and the 3-bit type code in the first byte, then
// 7 bits of size per continuation byte, little-endian, MSB = "more".
function packEntryHeader(typeCode: number, size: number): Uint8Array {
  let bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(first);
  return new Uint8Array(bytes);
}

/** Options for `decodePackBytes()`. */
export interface DecodePackOptions {
  /**
   * Hard cap on any single inflated object or delta result. This bounds allocations against a
   * hostile pack: claimed sizes are enforced *during* inflation, before the bytes materialize.
   */
  maxObjectSize: number;

  /**
   * Resolves a ref-delta base that is not itself in the pack ("thin pack"). Absent, or returning
   * undefined, makes such a delta a hard error. The fetches this codec serves never request thin
   * packs (no `have`s are ever sent), but a base already in the local store can still be offered.
   */
  resolveBase?: (oid: GitOid) => PackableObject | undefined;
}

/**
 * Decodes a whole packfile into its objects, resolving ofs- and ref-delta entries, in pack
 * order. This is hostile-input parsing: every size is enforced during inflation, the object
 * count and trailer SHA-1 must both check out, and any unresolved delta or trailing garbage is
 * a hard error -- an object can be misdescribed by its source, but it cannot make this function
 * allocate unboundedly or silently drop entries. (Content integrity is the caller's job: hash
 * each decoded object, as `GitCache.put()` does.)
 */
export async function decodePackBytes(
    pack: Uint8Array, options: DecodePackOptions): Promise<PackableObject[]> {
  if (pack.byteLength < 12 + 20) throw new Error("invalid packfile: too short");
  let view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  if (new TextDecoder().decode(pack.subarray(0, 4)) !== "PACK") {
    throw new Error("invalid packfile: bad magic");
  }
  let version = view.getUint32(4);
  if (version !== 2) throw new Error(`invalid packfile: unsupported version ${version}`);
  let count = view.getUint32(8);

  type Entry = {
    resolved?: PackableObject;
    delta?: Uint8Array;
    baseOffset?: number;
    baseOid?: GitOid;
  };
  let entries: Entry[] = [];
  let byOffset = new Map<number, number>();

  let pos = 12;
  let end = pack.byteLength - 20;
  for (let i = 0; i < count; i++) {
    let entryStart = pos;
    if (pos >= end) throw new Error("invalid packfile: truncated (fewer objects than declared)");

    // Entry header: type + size varint.
    let byte = pack[pos++];
    let typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let multiplier = 16;
    while (byte & 0x80) {
      if (pos >= end) throw new Error("invalid packfile: truncated entry header");
      byte = pack[pos++];
      size += (byte & 0x7f) * multiplier;
      multiplier *= 128;
    }
    if (size > options.maxObjectSize) {
      throw new Error(
          `invalid packfile: entry of ${size} bytes exceeds the ` +
          `${options.maxObjectSize}-byte limit`);
    }

    let entry: Entry = {};
    if (typeCode === OFS_DELTA) {
      // Negative-offset varint (note the "+1" accumulation quirk of the format).
      if (pos >= end) throw new Error("invalid packfile: truncated ofs-delta");
      byte = pack[pos++];
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        if (pos >= end) throw new Error("invalid packfile: truncated ofs-delta");
        byte = pack[pos++];
        offset = (offset + 1) * 128 + (byte & 0x7f);
      }
      entry.baseOffset = entryStart - offset;
      if (entry.baseOffset < 12 || !byOffset.has(entry.baseOffset)) {
        throw new Error("invalid packfile: ofs-delta references no entry boundary");
      }
    } else if (typeCode === REF_DELTA) {
      if (pos + 20 > end) throw new Error("invalid packfile: truncated ref-delta");
      entry.baseOid = toHex(pack.subarray(pos, pos + 20));
      pos += 20;
    } else if (PACK_CODE_TYPES[typeCode] === undefined) {
      throw new Error(`invalid packfile: unsupported object type code ${typeCode}`);
    }

    let { data, end: dataEnd } = inflatePackData(pack, pos, end, size);
    pos = dataEnd;
    if (typeCode === OFS_DELTA || typeCode === REF_DELTA) {
      entry.delta = data;
    } else {
      entry.resolved = { type: PACK_CODE_TYPES[typeCode], payload: data };
    }
    byOffset.set(entryStart, entries.length);
    entries.push(entry);
  }
  if (pos !== end) throw new Error("invalid packfile: trailing garbage after declared objects");

  let digest = new Uint8Array(await crypto.subtle.digest("SHA-1", pack.subarray(0, end)));
  if (toHex(digest) !== toHex(pack.subarray(end))) {
    throw new Error("invalid packfile: trailer SHA-1 mismatch");
  }

  // Resolve delta entries, memoized so shared bases along a chain inflate and apply once. An
  // ofs-delta names its base by entry offset (always backward). A ref-delta names it by oid,
  // which may be another entry in this pack or (thin packs) an object the caller can supply;
  // matching in-pack oids requires hashing, so the oid index below is built lazily -- only when
  // a ref-delta is actually present -- over already-resolved entries, repeating while progress
  // is made so ref-delta chains resolve too. `resolve` returns undefined for a ref-delta whose
  // base isn't known *yet*; the driver loop turns lack of progress into a hard error.
  let oidIndex = new Map<GitOid, number>();
  let resolve = (index: number, depth: number): PackableObject | undefined => {
    let entry = entries[index];
    if (entry.resolved) return entry.resolved;
    if (depth > MAX_DELTA_DEPTH) throw new Error("invalid packfile: delta chain too deep");
    let base: PackableObject | undefined;
    if (entry.baseOffset !== undefined) {
      base = resolve(byOffset.get(entry.baseOffset)!, depth + 1);
    } else {
      let inPack = oidIndex.get(entry.baseOid!);
      base = inPack !== undefined ? resolve(inPack, depth + 1)
                                  : options.resolveBase?.(entry.baseOid!);
    }
    if (base === undefined) return undefined;
    entry.resolved = {
      type: base.type,
      payload: applyGitDelta(entry.delta!, base.payload, options.maxObjectSize),
    };
    entry.delta = undefined;
    return entry.resolved;
  };

  let indexed = new Set<number>();
  for (;;) {
    let unresolved: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (resolve(i, 0) === undefined) unresolved.push(i);
    }
    if (unresolved.length === 0) break;
    for (let i = 0; i < entries.length; i++) {
      let resolved = entries[i].resolved;
      if (resolved && !indexed.has(i)) {
        indexed.add(i);
        oidIndex.set(await gitObjectOid(resolved.type, resolved.payload), i);
      }
    }
    // The next pass can only succeed if some unresolved ref-delta's base is now indexed.
    if (!unresolved.some(i => oidIndex.has(entries[i].baseOid ?? ""))) {
      throw new Error(
          `invalid packfile: delta base ` +
          `${entries[unresolved[0]].baseOid ?? "(by offset)"} is unavailable`);
    }
  }

  return entries.map(entry => entry.resolved!);
}

// Inflates one pack entry's zlib stream starting at `offset`, returning the data and the offset
// just past the stream's end. `expectedSize` comes from the (untrusted) entry header; it was
// pre-checked against the object-size cap, and enforced again here *during* inflation so a lying
// header cannot cause a larger allocation than it claimed.
// The Inflate internals this codec relies on beyond @types/pako's declarations, all stable pako
// API in practice (isomorphic-git's own pack parser relies on `strm.avail_in` the same way):
// `ended` flips when the zlib stream completes mid-input, and `strm.avail_in` is how many bytes
// of the last push() the stream did not consume -- together they locate the entry boundary.
interface InflateWithInternals {
  ended: boolean;
  err: number;
  msg: string;
  strm: { avail_in: number };
  onData: (chunk: Uint8Array) => void;
  push(data: Uint8Array, flush: boolean): void;
}

function inflatePackData(pack: Uint8Array, offset: number, end: number, expectedSize: number):
    { data: Uint8Array, end: number } {
  let inflator = new Inflate() as unknown as InflateWithInternals;
  let chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  inflator.onData = (chunk: Uint8Array) => {
    total += chunk.byteLength;
    if (total > expectedSize) {
      overflow = true;
      // pako offers no abort; raising here unwinds through push() below.
      throw new Error("pack entry exceeds declared size");
    }
    chunks.push(chunk);
  };

  const STEP = 65536;
  let pos = offset;
  try {
    while (!inflator.ended) {
      if (pos >= end) throw new Error("invalid packfile: truncated object data");
      let next = Math.min(pos + STEP, end);
      inflator.push(pack.subarray(pos, next), false);
      if (inflator.err) {
        throw new Error(`invalid packfile: corrupt object data (${inflator.msg || inflator.err})`);
      }
      pos = next;
    }
  } catch (err) {
    if (overflow) {
      throw new Error("invalid packfile: object larger than its declared size", { cause: err });
    }
    throw err;
  }

  if (total !== expectedSize) {
    throw new Error("invalid packfile: object smaller than its declared size");
  }
  return { data: concatBytes(chunks), end: pos - inflator.strm.avail_in };
}

/**
 * Applies a git delta (the inflated payload of an ofs-/ref-delta pack entry) to its base,
 * producing the target object payload. Sizes and every copy range are validated; the result is
 * capped at `maxSize` before it is allocated.
 */
export function applyGitDelta(delta: Uint8Array, base: Uint8Array, maxSize: number): Uint8Array {
  let pos = 0;
  let readVarint = (): number => {
    let value = 0;
    let factor = 1;
    let byte: number;
    do {
      if (pos >= delta.byteLength) throw new Error("invalid delta: truncated size");
      byte = delta[pos++];
      value += (byte & 0x7f) * factor;
      factor *= 128;
    } while (byte & 0x80);
    return value;
  };

  let baseSize = readVarint();
  if (baseSize !== base.byteLength) throw new Error("invalid delta: base size mismatch");
  let targetSize = readVarint();
  if (targetSize > maxSize) {
    throw new Error(`invalid delta: result of ${targetSize} bytes exceeds the ${maxSize}-byte limit`);
  }

  let target = new Uint8Array(targetSize);
  let written = 0;
  while (pos < delta.byteLength) {
    let op = delta[pos++];
    if (op & 0x80) {
      // Copy from base: bits 0-3 select offset bytes, bits 4-6 select size bytes.
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) {
        if (op & (1 << i)) {
          if (pos >= delta.byteLength) throw new Error("invalid delta: truncated copy op");
          offset += delta[pos++] * 2 ** (8 * i);
        }
      }
      for (let i = 0; i < 3; i++) {
        if (op & (0x10 << i)) {
          if (pos >= delta.byteLength) throw new Error("invalid delta: truncated copy op");
          size += delta[pos++] * 2 ** (8 * i);
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.byteLength || written + size > targetSize) {
        throw new Error("invalid delta: copy out of range");
      }
      target.set(base.subarray(offset, offset + size), written);
      written += size;
    } else if (op > 0) {
      // Insert literal bytes.
      if (pos + op > delta.byteLength || written + op > targetSize) {
        throw new Error("invalid delta: insert out of range");
      }
      target.set(delta.subarray(pos, pos + op), written);
      pos += op;
      written += op;
    } else {
      throw new Error("invalid delta: reserved zero op");
    }
  }
  if (written !== targetSize) throw new Error("invalid delta: result size mismatch");
  return target;
}
