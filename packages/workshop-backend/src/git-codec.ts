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
// isomorphic-git remains the engine for the existing full-materialization reads and for
// GitStore's tree writes (git-store.ts); tests cross-verify the two codecs over the same store.
// Every commit is written by the commit encoder here, GitStore's included: it is the one writer
// that can add a header (see GitCommit.headers), and the one place that decides what a commit's
// fields may hold. The tree encoder serves writers with no object store to hand isomorphic-git.
//
// Everything here is pure computation over bytes (the pack decoder reads a stream): no storage,
// no RPC. Loose objects use workerd's native node:zlib: storing a mount pack deflates every object
// it carries, and pako's deflate takes about twice the CPU of the native one. The pack decoder
// uses pako (the same library isomorphic-git bundles) because pack entries are concatenated zlib
// streams with no recorded lengths -- finding where one ends requires a streaming inflater that
// reports unconsumed input, which DecompressionStream cannot do.

import { constants, deflateSync, inflateSync } from "node:zlib";
import { Inflate, deflate } from "pako";
import type { GitObjectType, GitOid } from "@gadgets/workshop-shared/gatekeeper";
import type { CommitSignature } from "./worktree-binding";

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

function fromHex(hex: string): Uint8Array {
  let out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Concatenates byte arrays. */
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
// whole. These helpers are the raw codec behind GitObjectRecord.data (see
// storage-schema/overseer-storage.ts) -- byte-compatible with what isomorphic-git reads and
// writes there, though the compressed bytes need not be bit-identical (the store is keyed by
// oid; readers inflate).

/** Computes the oid of an object from its type and headerless payload. */
export async function gitObjectOid(type: GitObjectType, payload: Uint8Array): Promise<GitOid> {
  let header = ENCODER.encode(`${type} ${payload.byteLength}\0`);
  let digest = await crypto.subtle.digest("SHA-1", concatBytes([header, payload]));
  return toHex(new Uint8Array(digest));
}

/**
 * Encodes a loose object record's `data` bytes from a type and headerless payload, at zlib's
 * fastest level: deflating is the largest single cost of storing a pack, and the level trades
 * about a third of that CPU for some 10% more stored bytes.
 */
export function encodeLooseObject(type: GitObjectType, payload: Uint8Array): Uint8Array {
  let header = ENCODER.encode(`${type} ${payload.byteLength}\0`);
  return deflateSync(concatBytes([header, payload]), { level: constants.Z_BEST_SPEED });
}

/** Decodes a loose object record's `data` bytes into its type and headerless payload. */
export function decodeLooseObject(data: Uint8Array): { type: GitObjectType, payload: Uint8Array } {
  let whole: Uint8Array;
  try {
    // inflateSync returns a Buffer, a Uint8Array subclass whose slice() aliases rather than
    // copies; the payload handed out is a plain Uint8Array over the same bytes.
    let inflated = inflateSync(data);
    whole = new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength);
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

/**
 * Encodes a tree payload: the inverse of `parseGitTree()`. Entries may be given in any order and
 * are written in git's canonical one, which compares names bytewise as if a directory's name
 * ended in `/` -- so the file `a.b` precedes the directory `a`, which precedes the file `a0`. Any
 * other order is a different object with a different oid, and one real git rejects.
 *
 * Throws rather than write a tree that would not parse back to these entries: on a name git
 * cannot represent (empty, `.`, `..`, or containing `/` or NUL), on a name that is not
 * well-formed Unicode (it would not survive encoding, and could alias another entry), and on a
 * name given twice.
 */
export function encodeGitTree(entries: readonly GitTreeEntry[]): Uint8Array {
  let names = new Set<string>();
  let encoded = entries.map(({ mode, name, oid }) => {
    if (!TREE_ENTRY_MODES.includes(mode)) {
      throw new Error(`cannot encode tree: unsupported entry mode ${mode}`);
    }
    if (name === "" || name === "." || name === ".." || /[/\0]/.test(name) ||
        !name.isWellFormed()) {
      throw new Error(`cannot encode tree: invalid entry name ${JSON.stringify(name)}`);
    }
    if (names.has(name)) {
      throw new Error(`cannot encode tree: duplicate entry name ${JSON.stringify(name)}`);
    }
    names.add(name);
    return {
      sortKey: ENCODER.encode(mode === "40000" ? `${name}/` : name),
      bytes: concatBytes([ENCODER.encode(`${mode} ${name}\0`), fromHex(validateGitOid(oid))]),
    };
  });
  encoded.sort((a, b) => compareBytes(a.sortKey, b.sortKey));
  return concatBytes(encoded.map(entry => entry.bytes));
}

// Lexicographic order over unsigned bytes, a prefix sorting first: C's memcmp, extended to
// unequal lengths.
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  let length = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.byteLength - b.byteLength;
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

/**
 * Returns the values of every header named `name` in a commit payload, in the order they appear.
 * A value spanning continuation lines is returned joined by newlines, with each continuation
 * line's leading space removed, as git reads it. Like `parseGitCommitRefs()`, never decodes the
 * message.
 */
export function readGitCommitHeader(payload: Uint8Array, name: string): string[] {
  let decoder = new TextDecoder();
  let values: string[] = [];
  let current: string[] | undefined;  // the lines of the matching header being read, if any
  let pos = 0;
  while (pos < payload.byteLength) {
    let eol = payload.indexOf(0x0a, pos);
    if (eol < 0) eol = payload.byteLength;
    if (eol === pos) break;                    // blank line: end of headers
    let line = decoder.decode(payload.subarray(pos, eol));
    if (line.startsWith(" ")) {
      current?.push(line.slice(1));
    } else {
      if (current !== undefined) values.push(current.join("\n"));
      current = line.startsWith(`${name} `) ? [line.slice(name.length + 1)] : undefined;
    }
    pos = eol + 1;
  }
  if (current !== undefined) values.push(current.join("\n"));
  return values;
}

/** A header of a commit beyond the ones every commit has, as `encodeGitCommit()` writes it. */
export interface GitCommitHeader {
  /**
   * The header's name: letters, digits and dashes, starting with a letter. Never one that git
   * gives a meaning of its own, such as `parent` or `gpgsig`.
   */
  name: string;

  /** The header's value: a single line, possibly empty. */
  value: string;
}

// The headers git reads a meaning into. A commit may carry none of them as an extra header: the
// first four would contradict the commit's own fields, and the rest would claim an encoding or a
// signature that the commit does not have.
const GIT_COMMIT_HEADERS = new Set(
    ["tree", "parent", "author", "committer", "encoding", "gpgsig", "gpgsig-sha256", "mergetag"]);

/** A whole commit, as `encodeGitCommit()` writes it. */
export interface GitCommit extends GitCommitRefs {
  /** Who wrote the change, and when. */
  author: CommitSignature;

  /** Who created the commit, and when. */
  committer: CommitSignature;

  /** Further headers, written after `committer` in the order given. See `readGitCommitHeader()`. */
  headers?: readonly GitCommitHeader[];

  /**
   * The commit message. Normalized exactly as `GitStore` normalizes one, so that the same
   * message yields the same oid through either writer: carriage returns are removed, leading
   * newlines dropped, and the result ends with exactly one newline.
   */
  message: string;
}

/**
 * Encodes a commit payload. Parents are written in the order given, which is part of the
 * commit's identity, and so are the extra headers.
 *
 * Throws rather than write a commit that would not parse back to these fields: on a name or
 * email containing `<`, `>`, a newline or NUL (which would end the field early, and could forge
 * the headers after it), on a timestamp or UTC offset git's format cannot hold, and on an extra
 * header whose name is malformed or one of git's own, or whose value holds a newline or NUL.
 */
export function encodeGitCommit(commit: GitCommit): Uint8Array {
  let lines = [`tree ${validateGitOid(commit.tree)}`];
  for (let parent of commit.parents) lines.push(`parent ${validateGitOid(parent)}`);
  lines.push(`author ${formatCommitSignature(commit.author)}`);
  lines.push(`committer ${formatCommitSignature(commit.committer)}`);
  for (let { name, value } of commit.headers ?? []) {
    if (!/^[a-z][a-z0-9-]*$/i.test(name) || GIT_COMMIT_HEADERS.has(name.toLowerCase())) {
      throw new Error(`cannot encode commit: invalid header name ${JSON.stringify(name)}`);
    }
    if (/[\n\0]/.test(value)) {
      throw new Error(
          `cannot encode commit: the value of header ${name} contains a newline or NUL`);
    }
    lines.push(`${name} ${value}`);
  }

  let message = commit.message.replaceAll("\r", "");
  let start = 0;
  let end = message.length;
  while (start < end && message[start] === "\n") start++;
  while (end > start && message[end - 1] === "\n") end--;
  return ENCODER.encode(`${lines.join("\n")}\n\n${message.slice(start, end)}\n`);
}

// The characters a signature's name or email cannot hold.
const SIGNATURE_UNSAFE = /[<>\n\0]/g;

/**
 * Drops from a name or email the characters that a commit's signature cannot hold, as git
 * drops them, so that `encodeGitCommit()` takes it rather than refusing it. For a name or email
 * that someone chose, which has no reason to hold them.
 */
export function signatureSafe(text: string): string {
  return text.replace(SIGNATURE_UNSAFE, "");
}

// Formats an author or committer header's value: `<name> <<email>> <seconds> <+hhmm|-hhmm>`.
function formatCommitSignature(signature: CommitSignature): string {
  let { name, email, utcOffsetMinutes } = signature;
  if (signatureSafe(name) !== name || signatureSafe(email) !== email) {
    throw new Error(
        "cannot encode commit: a name or email contains '<', '>', a newline or NUL");
  }
  let seconds = Math.floor(signature.timestamp.getTime() / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new Error("cannot encode commit: timestamp is invalid or precedes 1970");
  }
  let zone = Math.abs(utcOffsetMinutes);
  if (!Number.isInteger(zone) || zone >= 100 * 60) {
    throw new Error(`cannot encode commit: invalid UTC offset ${utcOffsetMinutes}`);
  }
  let hhmm = String(Math.floor(zone / 60)).padStart(2, "0") + String(zone % 60).padStart(2, "0");
  return `${name} <${email}> ${seconds} ${utcOffsetMinutes < 0 ? "-" : "+"}${hhmm}`;
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

/** Options for `decodePackStream()`. */
export interface DecodePackOptions {
  /** Hard cap on the pack's total byte size, enforced as the bytes arrive. */
  maxPackSize: number;

  /**
   * Hard cap on any single inflated object or delta result. This bounds allocations against a
   * hostile pack: claimed sizes are enforced *during* inflation, before the bytes materialize.
   */
  maxObjectSize: number;

  /**
   * Supplies a delta's base by oid. The decoder retains no objects, so this must return any it
   * has already yielded (see `decodePackStream()` on ordering) as well as any the caller already
   * has. Undefined makes the delta a hard error.
   */
  resolveBase: (oid: GitOid) => PackableObject | undefined;
}

/**
 * Decodes a packfile stream into its objects and their oids, in pack order, in one pass that
 * retains none of them. This is hostile-input parsing: every size is enforced during inflation,
 * the object count and trailer SHA-1 must both check out, and any unresolved delta or trailing
 * garbage is a hard error -- an object can be misdescribed by its source, but it cannot make this
 * function allocate unboundedly or silently drop entries. Each oid is computed from the object's
 * bytes, but the pack as a whole verifies only when the generator completes, so an object acted
 * on earlier may belong to a pack that then fails.
 *
 * One pass means a delta must follow its base. Ofs-deltas point backward by format, and
 * `git pack-objects` writes ref-delta bases first too, so every pack upload-pack sends for a fetch
 * without `have`s -- the only kind this codec serves -- qualifies.
 */
export async function* decodePackStream(
    pack: ReadableStream<Uint8Array>, options: DecodePackOptions)
    : AsyncGenerator<PackableObject & { oid: GitOid }> {
  using reader = new PackReader(pack, options.maxPackSize);
  let header = await reader.bytes(12);
  if (new TextDecoder().decode(header.subarray(0, 4)) !== "PACK") {
    throw new Error("invalid packfile: bad magic");
  }
  let view = new DataView(header.buffer);
  let version = view.getUint32(4);
  if (version !== 2) throw new Error(`invalid packfile: unsupported version ${version}`);
  let count = view.getUint32(8);

  let oidAt = new Map<number, GitOid>();  // by entry offset, for ofs-delta bases
  for (let i = 0; i < count; i++) {
    let entryStart = reader.offset;

    // Entry header: type + size varint.
    let byte = await reader.byte();
    let typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    for (let multiplier = 16; byte & 0x80; multiplier *= 128) {
      // No size within the cap has a digit worth this much. (Left to run, a varint of zeros
      // overflows the multiplier into a NaN size that the check below would let through.)
      if (multiplier > options.maxObjectSize) {
        throw new Error(
            `invalid packfile: entry size exceeds the ${options.maxObjectSize}-byte limit`);
      }
      byte = await reader.byte();
      size += (byte & 0x7f) * multiplier;
    }
    if (size > options.maxObjectSize) {
      throw new Error(
          `invalid packfile: entry of ${size} bytes exceeds the ` +
          `${options.maxObjectSize}-byte limit`);
    }

    let baseOid: GitOid | undefined;
    if (typeCode === OFS_DELTA) {
      // Negative-offset varint (note the "+1" accumulation quirk of the format).
      byte = await reader.byte();
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        byte = await reader.byte();
        offset = (offset + 1) * 128 + (byte & 0x7f);
      }
      baseOid = oidAt.get(entryStart - offset);
      if (baseOid === undefined) {
        throw new Error("invalid packfile: ofs-delta references no entry boundary");
      }
    } else if (typeCode === REF_DELTA) {
      baseOid = toHex(await reader.bytes(20));
    } else if (PACK_CODE_TYPES[typeCode] === undefined) {
      throw new Error(`invalid packfile: unsupported object type code ${typeCode}`);
    }

    let type = PACK_CODE_TYPES[typeCode];
    let payload = await reader.inflate(size);
    if (baseOid !== undefined) {
      let base = options.resolveBase(baseOid);
      if (base === undefined) {
        throw new Error(`invalid packfile: delta base ${baseOid} is unavailable`);
      }
      type = base.type;
      payload = applyGitDelta(payload, base.payload, options.maxObjectSize);
    }
    let oid = await gitObjectOid(type, payload);
    oidAt.set(entryStart, oid);
    yield { oid, type, payload };
  }

  let digest = await reader.endBody();
  let trailer = toHex(await reader.bytes(20));
  if (await reader.more()) {
    throw new Error("invalid packfile: trailing garbage after declared objects");
  }
  if (trailer !== digest) throw new Error("invalid packfile: trailer SHA-1 mismatch");
}

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

const PACK_READ_SIZE = 64 << 10;

// decodePackStream's reads, in order, hashing every byte before `endBody()` (the trailer's SHA-1
// input) a chunk at a time. Reads are BYOB, which a gatekeeper facet's pack stream supports once
// Workers RPC has carried it to the overseer (verified for the gatekeepers' pull-based stream
// shape): a default reader gets 4 KiB chunks there, and each read after one of the caller's
// storage writes costs an implicit commit (a TypeScript-size pack took 7.0 s of reads instead of
// 2.8 s, in workerd).
class PackReader {
  #reader: ReadableStreamBYOBReader;
  #maxSize: number;
  #digest = new crypto.DigestStream("SHA-1");
  #hash: WritableStreamDefaultWriter<ArrayBuffer | ArrayBufferView> | undefined =
      this.#digest.getWriter();
  #chunk = new Uint8Array(0);
  #pos = 0;
  #received = 0;

  constructor(stream: ReadableStream<Uint8Array>, maxSize: number) {
    this.#reader = stream.getReader({ mode: "byob" });
    this.#maxSize = maxSize;
  }

  /** The pack offset of the next unread byte. */
  get offset(): number {
    return this.#received - this.#chunk.byteLength + this.#pos;
  }

  /** Whether any bytes remain, buffering at least one if so. */
  async more(): Promise<boolean> {
    while (this.#pos === this.#chunk.byteLength) {
      let next = await this.#reader.read(new Uint8Array(PACK_READ_SIZE));
      if (next.done) return false;
      this.#received += next.value.byteLength;
      if (this.#received > this.#maxSize) {
        throw new Error(`packfile exceeds the ${this.#maxSize}-byte limit`);
      }
      await this.#hash?.write(this.#chunk);
      this.#chunk = next.value;
      this.#pos = 0;
    }
    return true;
  }

  async byte(): Promise<number> {
    await this.#fill();
    return this.#chunk[this.#pos++];
  }

  async bytes(n: number): Promise<Uint8Array> {
    let out = new Uint8Array(n);
    for (let filled = 0; filled < n;) {
      await this.#fill();
      let part = this.#chunk.subarray(this.#pos, this.#pos + n - filled);
      out.set(part, filled);
      filled += part.byteLength;
      this.#pos += part.byteLength;
    }
    return out;
  }

  // Inflates the zlib stream at the read position. `size` comes from the (untrusted) entry
  // header; it was pre-checked against the object-size cap, and is enforced again here *during*
  // inflation so a lying header cannot cause a larger allocation than it claimed.
  async inflate(size: number): Promise<Uint8Array> {
    let inflator = new Inflate() as unknown as InflateWithInternals;
    let chunks: Uint8Array[] = [];
    let total = 0;
    let overflow = false;
    inflator.onData = (chunk: Uint8Array) => {
      total += chunk.byteLength;
      if (total > size) {
        overflow = true;
        // pako offers no abort; raising here unwinds through push() below.
        throw new Error("pack entry exceeds declared size");
      }
      chunks.push(chunk);
    };

    try {
      while (!inflator.ended) {
        await this.#fill();
        inflator.push(this.#chunk.subarray(this.#pos), false);
        if (inflator.err) {
          throw new Error(`invalid packfile: corrupt object data (${inflator.msg || inflator.err})`);
        }
        this.#pos = this.#chunk.byteLength - inflator.strm.avail_in;
      }
    } catch (err) {
      if (overflow) {
        throw new Error("invalid packfile: object larger than its declared size", { cause: err });
      }
      throw err;
    }

    if (total !== size) {
      throw new Error("invalid packfile: object smaller than its declared size");
    }
    return concatBytes(chunks);
  }

  /** Ends the hashed body at the read position, returning its SHA-1 (hex). */
  async endBody(): Promise<string> {
    let hash = this.#hash!;
    this.#hash = undefined;
    await hash.write(this.#chunk.subarray(0, this.#pos));
    await hash.close();
    return toHex(new Uint8Array(await this.#digest.digest));
  }

  // Cancels the source (a no-op once it has ended). Not awaited: a cancel can wait behind the
  // source's in-flight read.
  [Symbol.dispose](): void {
    this.#reader.cancel().catch(() => {});
  }

  async #fill(): Promise<void> {
    if (!await this.more()) throw new Error("invalid packfile: truncated");
  }
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
