// Hand-rolled git object and packfile codec: every git object the workspace reads or writes is
// parsed or encoded here, by the git store (git-cache.ts) and by blueprint releases
// (blueprint-release.ts), along with the packs of `GitCache.buildPack()`/`consumePack()`.
//
// Parsers attribute their errors to the object (a tree with a non-UTF-8 entry name fails naming
// the tree) and see all five tree entry modes. Encoders refuse anything that would not parse
// back as given, so the encoder is the one place that decides what an object's fields may hold.
// Pack *decoding* is hostile-input parsing (any gatekeeper can feed `consumePack()` anything),
// so it bounds allocations and fails loudly.
//
// Everything here is pure computation over bytes (the pack decoder reads a stream): no storage,
// no RPC.
//
// All compression is workerd's native node:zlib, at GIT_DEFLATE_LEVEL. DecompressionStream
// cannot decode packs: pack entries are zlib streams concatenated with no recorded lengths, and
// it both rejects the bytes that follow a stream ("trailing junk") and never says where the
// stream ended. node:zlib's inflaters stop at the end of the zlib stream, ignore what follows,
// and report the input they consumed as `bytesWritten`, which is how the pack decoder finds each
// entry's end (see PackReader.inflate()).

import {
  constants, createDeflate, createInflate, deflateSync, inflateSync, type Inflate,
} from "node:zlib";
import { createHash, type Hash } from "node:crypto";
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
// storage-schema/overseer-storage.ts) -- byte-compatible with git's own loose objects, though
// the compressed bytes need not be bit-identical (the store is keyed by oid; readers inflate).

/**
 * A SHA-1 hasher primed with the header of an object of `type` and payload length `size`: feed
 * it exactly `size` payload bytes, in any number of updates, and its hex digest is the object's
 * oid. This is the one place the hashed header's format is written.
 */
export function gitObjectHasher(type: GitObjectType, size: number): Hash {
  return createHash("sha1").update(`${type} ${size}\0`);
}

/** Computes the oid of an object from its type and headerless payload. */
export async function gitObjectOid(type: GitObjectType, payload: Uint8Array): Promise<GitOid> {
  return gitObjectHasher(type, payload.byteLength).update(payload).digest("hex");
}

/**
 * The oid a blob holding `text` (UTF-8) has or would have -- git's content address, computed
 * without writing anything. Equal text always yields an equal oid, so this is how content the
 * agent knows from a chat's session is compared against a committed file without reading the
 * committed blob (see the agent's read-before-edit stamps).
 */
export async function blobOid(text: string): Promise<GitOid> {
  return await gitObjectOid("blob", ENCODER.encode(text));
}

/**
 * The zlib level of every deflate of git data: stored objects and pack output alike. It is
 * zlib's fastest level (`Z_BEST_SPEED`), since deflating is the largest single cost of storing a
 * pack, and CPU is what limits large mounts: level 1 deflates about 1.5x faster than the default
 * level 6 for some 10% more stored bytes. The level never affects an oid, which is computed over
 * the inflated bytes.
 */
export const GIT_DEFLATE_LEVEL = constants.Z_BEST_SPEED;

/** Encodes a loose object record's `data` bytes from a type and headerless payload. */
export function encodeLooseObject(type: GitObjectType, payload: Uint8Array): Uint8Array {
  let header = ENCODER.encode(`${type} ${payload.byteLength}\0`);
  return deflateSync(concatBytes([header, payload]), { level: GIT_DEFLATE_LEVEL });
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

/**
 * The oid of the tree with no entries. Like git, which answers for it in every repository, the
 * git store treats it as always present, whether or not it was ever stored.
 */
export const EMPTY_TREE_OID: GitOid = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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

/**
 * Whether git tooling refuses a tree entry of this name, as git's own `verify_path()` and `fsck`
 * do (and with them hosts such as GitHub, which refuse a push carrying one): a name containing a
 * backslash, or one that some filesystem would resolve to `.`, `..` or `.git` -- ignoring case,
 * HFS+'s ignorable characters, NTFS's trailing dots and spaces, its `:stream` suffixes and its
 * `git~1` short names. `encodeGitTree()` writes such names, since a tree from elsewhere may hold
 * one; it is for writers to refuse a name of their own choosing.
 */
export function isReservedTreeEntryName(name: string): boolean {
  let hfs = name.replace(/[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/g, "");
  let ntfs = hfs.split(":")[0].toLowerCase().replace(/[. ]+$/, "");
  return name.includes("\\") || hfs === "." || hfs === ".." || ntfs === ".git" ||
      /^\.?git~[1-9]$/.test(ntfs);
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

/** A commit's fields, as `parseGitCommit()` reads them: all but its extra headers. */
export interface GitCommitFields extends GitCommitRefs {
  /** Who wrote the change, and when. */
  author: CommitSignature;

  /** Who created the commit, and when. */
  committer: CommitSignature;

  /**
   * The commit message, normalized as git normalizes one: carriage returns are removed, leading
   * newlines dropped, and the result ends with exactly one newline.
   */
  message: string;
}

/** A whole commit, as `encodeGitCommit()` writes it. */
export interface GitCommit extends GitCommitFields {
  /** Further headers, written after `committer` in the order given. See `readGitCommitHeader()`. */
  headers?: readonly GitCommitHeader[];
}

// The normalization of GitCommitFields.message.
function normalizeCommitMessage(message: string): string {
  message = message.replaceAll("\r", "");
  let start = 0;
  let end = message.length;
  while (start < end && message[start] === "\n") start++;
  while (end > start && message[end - 1] === "\n") end--;
  return `${message.slice(start, end)}\n`;
}

/**
 * Parses a commit payload into its fields; `readGitCommitHeader()` reads any others. Names,
 * emails and the message are decoded leniently, as git displays them, and the message is
 * normalized (see `GitCommitFields.message`). Throws on a commit whose tree, parents, author or
 * committer cannot be read.
 */
export function parseGitCommit(payload: Uint8Array, commitOid?: GitOid): GitCommitFields {
  let where = commitOid ?? "(unidentified)";
  let text = new TextDecoder().decode(payload);
  let blank = text.indexOf("\n\n");
  let headerLines = (blank < 0 ? text : text.slice(0, blank)).split("\n");
  let signature = (name: string): CommitSignature => {
    let line = headerLines.find(header => header.startsWith(`${name} `));
    let match = line && /^(.*) <(.*)> (\d+) ([+-])(\d\d)(\d\d)$/.exec(line.slice(name.length + 1));
    if (!match) throw new Error(`corrupt commit object ${where}: malformed ${name} header`);
    let [, personName, email, seconds, sign, hours, minutes] = match;
    let offset = Number(hours) * 60 + Number(minutes);
    return {
      name: personName,
      email,
      timestamp: new Date(Number(seconds) * 1000),
      utcOffsetMinutes: sign === "-" && offset !== 0 ? -offset : offset,
    };
  };
  return {
    ...parseGitCommitRefs(payload, commitOid),
    author: signature("author"),
    committer: signature("committer"),
    message: normalizeCommitMessage(blank < 0 ? "" : text.slice(blank + 2)),
  };
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
  return ENCODER.encode(`${lines.join("\n")}\n\n${normalizeCommitMessage(commit.message)}`);
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
    chunks.push(deflateSync(object.payload, { level: GIT_DEFLATE_LEVEL }));
  }

  chunks.push(new Uint8Array(await crypto.subtle.digest("SHA-1", concatBytes(chunks))));
  return chunks;
}

/**
 * A blob to pack from its pieces, never held whole: `buildPackStream()` deflates it as they
 * arrive. For a blob too large to buffer (a stored chunked blob's `BlobReader.pieces()`).
 */
export interface StreamedBlobEntry {
  type: "blob";

  /** The payload's byte length: the total length of `pieces()`. */
  size: number;

  /** The payload, in order. Pieces may be borrowed; each is read before the next is asked for. */
  pieces(): Iterable<Uint8Array>;
}

/** An object for `buildPackStream()` to pack: whole, or a blob streamed from its pieces. */
export type PackEntrySource = PackableObject | StreamedBlobEntry;

/**
 * Streams an undeltified packfile of a known number of objects (see `buildPackBytes()`), pulled
 * one output piece at a time, so memory stays bounded by one object rather than the whole pack:
 * and by much less for a streamed blob, which is deflated a piece at a time, each piece's output
 * emitted before the next piece is read.
 */
export function buildPackStream(count: number, objects: AsyncIterable<PackEntrySource>)
    : ReadableStream<Uint8Array> {
  async function* chunks() {
    const hash = createHash("sha1");
    const header = new Uint8Array(12);
    header.set(ENCODER.encode("PACK"));
    new DataView(header.buffer).setUint32(4, 2);
    new DataView(header.buffer).setUint32(8, count);
    hash.update(header);
    yield header;
    let emitted = 0;
    for await (const object of objects) {
      const size = "pieces" in object ? object.size : object.payload.byteLength;
      const entry = packEntryHeader(PACK_TYPE_CODES[object.type]!, size);
      hash.update(entry);
      yield entry;
      const body = "pieces" in object
          ? deflatePieces(object.pieces(), size)
          : [deflateSync(object.payload, { level: GIT_DEFLATE_LEVEL })];
      for await (const bytes of body) {
        hash.update(bytes);
        yield bytes;
      }
      ++emitted;
    }
    if (emitted !== count) throw new Error("Git pack object count changed.");
    yield new Uint8Array(hash.digest());
  }
  const iterator = chunks();
  return new ReadableStream({
    type: "bytes",
    async pull(controller) {
      const item = await iterator.next();
      if (item.done) controller.close(); else controller.enqueue(item.value);
    },
    async cancel() { await iterator.return(undefined); },
  }, {highWaterMark: 0});
}

// Deflates a payload arriving in pieces into one zlib stream, yielding its output as it is
// produced. Each piece is written only once the previous one's output has been taken, so no more
// than about one piece's output is ever queued. Throws if the pieces total other than `size`.
async function* deflatePieces(pieces: Iterable<Uint8Array>, size: number)
    : AsyncGenerator<Uint8Array> {
  const deflater = createDeflate({ level: GIT_DEFLATE_LEVEL });
  let output: Uint8Array[] = [];
  let failure: unknown;
  let wake: () => void = () => {};
  deflater.on("data", (bytes: Uint8Array) => {
    // Copied: a piece views zlib's output buffer, shared with the pieces after it, and the
    // pack's byte stream transfers what it is given.
    output.push(Uint8Array.prototype.slice.call(bytes));
  });
  deflater.on("end", () => wake());
  deflater.on("error", err => {
    failure ??= err;
    wake();
  });
  // Resolves once the deflater has consumed what `start` wrote, or has ended, or failed.
  const settle = (start: (done: () => void) => void) => new Promise<void>(resolve => {
    wake = resolve;
    start(resolve);
  });
  try {
    let total = 0;
    for (const piece of pieces) {
      total += piece.byteLength;
      if (total > size) throw new Error("Git pack blob is larger than its declared size.");
      await settle(done => deflater.write(piece, () => done()));
      if (failure !== undefined) throw failure;
      yield* output.splice(0);
    }
    if (total !== size) throw new Error("Git pack blob is smaller than its declared size.");
    await settle(() => deflater.end());
    if (failure !== undefined) throw failure;
    yield* output.splice(0);
  } finally {
    deflater.destroy();
  }
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
  /** Hard cap on the pack's total byte size, enforced as the bytes arrive. Absent: no cap. */
  maxPackSize?: number;

  /**
   * Hard cap on any single inflated object or delta result, checked against its declared size
   * before any of it is produced. Absent: no cap. Without one, an allocation is still never
   * larger than an entry declares, since declared sizes are enforced *during* inflation, before
   * the bytes materialize; and a blob streamed to `openBlobSink()` is never allocated whole.
   */
  maxObjectSize?: number;

  /**
   * Supplies a delta's base by oid. The decoder retains no objects, so this must return any it
   * has already yielded (see `decodePackStream()` on ordering) as well as any the caller already
   * has -- but for a blob it can only read in ranges, which `resolveLargeBase` supplies.
   * Undefined from both makes the delta a hard error.
   */
  resolveBase: (oid: GitOid) => PackableObject | undefined;

  /**
   * Supplies a delta's base, consulted when `resolveBase()` has none: a *blob*, read by range
   * (a stored chunked blob's BlobReader). This is how a delta against a blob streamed to
   * `openBlobSink()` finds its base.
   */
  resolveLargeBase?: (oid: GitOid) => DeltaBase | undefined;

  /**
   * Offered each blob the pack carries -- an entry, or a delta whose base is a blob -- with its
   * size, before any of its payload is produced. A sink returned receives the payload in pieces
   * instead of the decoder buffering it, and the entry is yielded without it (`stored: true`).
   * The sink must have stored the blob when `finish()` returns, since a later delta may name it
   * as its base. Undefined buffers the blob as any other object.
   */
  openBlobSink?: (size: number) => PackBlobSink | undefined;
}

/** A destination `decodePackStream()` streams one blob's payload to; see `openBlobSink`. */
export interface PackBlobSink {
  /** Appends payload bytes, which are borrowed: valid only during the call. */
  write(piece: Uint8Array): void;

  /** Ends the blob, storing it, and returns its oid, computed from the bytes written. */
  finish(): GitOid;
}

/** An object `decodePackStream()` yields. */
export type DecodedPackObject =
  /** An object, whole. */
  | PackableObject & { oid: GitOid, stored?: undefined }
  /** A blob streamed to `openBlobSink()`, which has stored it: its payload is not here. */
  | { oid: GitOid, type: "blob", size: number, stored: true, payload?: undefined };

/**
 * Decodes a packfile stream into its objects and their oids, in pack order, in one pass that
 * retains none of them. This is hostile-input parsing: every size is enforced during inflation,
 * the object count and trailer SHA-1 must both check out, and any unresolved delta or trailing
 * garbage is a hard error -- an object can be misdescribed by its source, but it cannot make this
 * function allocate more than it declares or silently drop entries. Each oid is computed from the
 * object's bytes, but the pack as a whole verifies only when the generator completes, so an
 * object acted on earlier may belong to a pack that then fails.
 *
 * A blob of any size can pass through in bounded memory, given `openBlobSink()`: its entry is
 * inflated, or its delta applied (see GitDeltaApplier), a piece at a time into the sink, and a
 * delta's base is read by range where the delta copies from it.
 *
 * One pass means a delta must follow its base. Ofs-deltas point backward by format, and
 * `git pack-objects` writes ref-delta bases first too, so every pack upload-pack sends for a fetch
 * without `have`s -- the only kind this codec serves -- qualifies.
 */
export function decodePackStream(
    pack: ReadableStream<Uint8Array>, options: DecodePackOptions & { openBlobSink?: undefined })
    : AsyncGenerator<PackableObject & { oid: GitOid }>;
export function decodePackStream(pack: ReadableStream<Uint8Array>, options: DecodePackOptions)
    : AsyncGenerator<DecodedPackObject>;
export async function* decodePackStream(
    pack: ReadableStream<Uint8Array>, options: DecodePackOptions)
    : AsyncGenerator<DecodedPackObject> {
  let maxObjectSize = options.maxObjectSize ?? Number.MAX_SAFE_INTEGER;
  let sizeError = (size: number) => new Error(options.maxObjectSize === undefined
      ? "invalid packfile: entry size is too large"
      : `invalid packfile: entry of ${size} bytes exceeds the ${maxObjectSize}-byte limit`);
  using reader = new PackReader(pack, options.maxPackSize ?? Infinity);
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
      if (multiplier > maxObjectSize) {
        throw new Error(options.maxObjectSize === undefined
            ? "invalid packfile: entry size is too large"
            : `invalid packfile: entry size exceeds the ${maxObjectSize}-byte limit`);
      }
      byte = await reader.byte();
      size += (byte & 0x7f) * multiplier;
    }
    if (size > maxObjectSize) throw sizeError(size);

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

    let entry: DecodedPackObject;
    if (baseOid === undefined) {
      let type = PACK_CODE_TYPES[typeCode];
      let sink = type === "blob" ? options.openBlobSink?.(size) : undefined;
      if (sink !== undefined) {
        await reader.inflateTo(size, piece => sink.write(piece));
        entry = { oid: sink.finish(), type: "blob", size, stored: true };
      } else {
        let payload = await reader.inflate(size);
        entry = { oid: await gitObjectOid(type, payload), type, payload };
      }
    } else {
      let held = options.resolveBase(baseOid);
      let large = held === undefined ? options.resolveLargeBase?.(baseOid) : undefined;
      if (held === undefined && large === undefined) {
        throw new Error(`invalid packfile: delta base ${baseOid} is unavailable`);
      }
      let type = held?.type ?? "blob";
      // Where the result goes, chosen once the delta's header gives its size.
      let target: { sink?: PackBlobSink, payload?: Uint8Array } = {};
      let applier = new GitDeltaApplier(large ?? bytesDeltaBase(held!.payload), targetSize => {
        if (targetSize > maxObjectSize) throw sizeError(targetSize);
        let sink = type === "blob" ? options.openBlobSink?.(targetSize) : undefined;
        if (sink !== undefined) {
          target.sink = sink;
          return piece => sink.write(piece);
        }
        return bufferSink(target.payload = new Uint8Array(targetSize));
      });
      await reader.inflateTo(size, piece => applier.push(piece));
      applier.finish();
      entry = target.sink !== undefined
          ? { oid: target.sink.finish(), type: "blob", size: applier.targetSize!, stored: true }
          : { oid: await gitObjectOid(type, target.payload!), type, payload: target.payload! };
    }
    oidAt.set(entryStart, entry.oid);
    yield entry;
  }

  let digest = await reader.endBody();
  let trailer = toHex(await reader.bytes(20));
  if (await reader.more()) {
    throw new Error("invalid packfile: trailing garbage after declared objects");
  }
  if (trailer !== digest) throw new Error("invalid packfile: trailer SHA-1 mismatch");
}

const PACK_READ_SIZE = 64 << 10;

/**
 * The largest pack entry `PackReader.inflateTo()` inflates in one synchronous call over a window
 * of the pack; larger ones are inflated as a stream, a read at a time. It equals CHUNK_MAX_SIZE
 * (git-chunked-blob.ts, which imports this module, so it cannot be imported here), so that every
 * blob entry large enough to be stored chunked, and so streamed into a BlobWriter, is inflated
 * as a stream too, and is never held whole.
 */
const PACK_SYNC_INFLATE_LIMIT = 1 << 20;

// The most bytes zlib's own encoder emits for `size` bytes of input, at any level: zlib's
// compressBound() plus its 6-byte header and trailer. Another encoder can exceed it, which
// PackReader.inflate() tolerates, only more slowly.
function zlibBound(size: number): number {
  return size + (size >> 12) + (size >> 14) + (size >> 25) + 13 + 6;
}

// What inflateSync() returns given `info: true`, which @types/node does not model: the output,
// and the inflater whose `bytesWritten` is the input it consumed.
interface InflateSyncInfo {
  buffer: Uint8Array;
  engine: Inflate;
}

// Whether a zlib error means its input ended before the zlib stream did.
function isTruncatedInput(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "Z_BUF_ERROR";
}

// The pack error for a zlib failure other than truncated input. maxOutputLength, set at an
// entry's declared size, fails with a RangeError (ERR_BUFFER_TOO_LARGE); anything else is
// malformed data.
function packInflateError(err: unknown): Error {
  if (err instanceof RangeError) {
    return new Error("invalid packfile: object larger than its declared size", { cause: err });
  }
  let message = err instanceof Error ? err.message : String(err);
  return new Error(`invalid packfile: corrupt object data (${message})`, { cause: err });
}

// decodePackStream's reads, in order, hashing every byte before `endBody()` (the trailer's SHA-1
// input) a chunk at a time. Reads are BYOB, which a gatekeeper facet's pack stream supports once
// Workers RPC has carried it to the overseer (verified for the gatekeepers' pull-based stream
// shape): a default reader gets 4 KiB chunks there, and each read after one of the caller's
// storage writes costs an implicit commit (a TypeScript-size pack took 7.0 s of reads instead of
// 2.8 s, in workerd).
//
// The read position is in `#chunk`, the bytes of the last read, and every read is hashed as the
// position leaves it. `window()` may replace `#chunk` with a larger buffer holding its unread
// bytes followed by further reads, hashing the read bytes it leaves behind.
class PackReader {
  #reader: ReadableStreamBYOBReader;
  #maxSize: number;
  #digest = new crypto.DigestStream("SHA-1");
  #hash: WritableStreamDefaultWriter<ArrayBuffer | ArrayBufferView> | undefined =
      this.#digest.getWriter();
  #chunk: Uint8Array = new Uint8Array(0);
  #pos = 0;
  #received = 0;
  #ended = false;

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
      let { bytes, done } = await this.#read(new Uint8Array(PACK_READ_SIZE));
      if (done) return false;
      await this.#hash?.write(this.#chunk);
      this.#chunk = bytes;
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

  /**
   * A contiguous view of the next `n` bytes without consuming them, or of all that remain if
   * fewer do. A view into the current read where it holds them all.
   *
   * Otherwise the unread bytes move to one new buffer, and further reads fill it in place, so
   * the memory held is the window's, however short the source's reads: a read's view retains its
   * whole buffer, so keeping each read whole would hold a full read buffer per read, short or not.
   */
  async window(n: number): Promise<Uint8Array> {
    if (!await this.more()) return new Uint8Array(0);
    let unread = this.#chunk.subarray(this.#pos);
    if (unread.byteLength >= n) return unread.subarray(0, n);

    let buffer: Uint8Array = new Uint8Array(Math.max(n, PACK_READ_SIZE));
    buffer.set(unread);
    let filled = unread.byteLength;
    await this.#hash?.write(this.#chunk.subarray(0, this.#pos));
    this.#chunk = buffer.subarray(0, filled);
    this.#pos = 0;
    while (filled < n) {
      let { bytes, done } = await this.#read(buffer.subarray(filled));
      buffer = new Uint8Array(bytes.buffer);
      filled += bytes.byteLength;
      this.#chunk = buffer.subarray(0, filled);
      if (done) break;
    }
    return this.#chunk.subarray(0, n);
  }

  /** Consumes `n` bytes. */
  async skip(n: number): Promise<void> {
    while (n > 0) {
      await this.#fill();
      let step = Math.min(n, this.#chunk.byteLength - this.#pos);
      this.#pos += step;
      n -= step;
    }
  }

  // Inflates the zlib stream at the read position. `size` comes from the (untrusted) entry
  // header; it was pre-checked against the object-size cap, and is enforced again here *during*
  // inflation so a lying header cannot cause a larger allocation than it claimed.
  //
  // An entry of up to PACK_SYNC_INFLATE_LIMIT is inflated in one inflateSync() over a window of
  // the pack long enough for any stream zlib would encode it as. A valid stream can be longer
  // (one padded with empty stored blocks, say), and then the window ends before the stream does;
  // that entry, and every larger one, is inflated as a stream instead.
  async inflate(size: number): Promise<Uint8Array> {
    let pieces: Uint8Array[] = [];
    await this.inflateTo(size, piece => { pieces.push(piece); });
    return pieces.length === 1 ? pieces[0] : concatBytes(pieces);
  }

  // inflate(), delivering the payload to `onData` in non-empty pieces as zlib produces them
  // rather than whole: one piece for an entry inflated synchronously, a read's worth at a time
  // for one inflated as a stream. A piece may view a buffer that zlib shares with the pieces
  // after it: zlib never overwrites it, but transferring it would detach theirs. If `onData`
  // throws, inflation stops and this rejects with what it threw.
  async inflateTo(size: number, onData: (piece: Uint8Array) => void): Promise<void> {
    if (size <= PACK_SYNC_INFLATE_LIMIT) {
      let bound = zlibBound(size);
      let window = await this.window(bound);
      let result: InflateSyncInfo | undefined;
      try {
        // maxOutputLength must be positive; a 1-byte output for a size-0 entry is caught below.
        result = inflateSync(window, { info: true, maxOutputLength: Math.max(size, 1) }) as
            unknown as InflateSyncInfo;
      } catch (err) {
        if (!isTruncatedInput(err)) throw packInflateError(err);
        if (window.byteLength < bound) {
          throw new Error("invalid packfile: truncated", { cause: err });
        }
        // Else the stream is longer than the window: inflate it as a stream, below.
      }
      if (result !== undefined) {
        if (result.buffer.byteLength > size) {
          throw new Error("invalid packfile: object larger than its declared size");
        }
        if (result.buffer.byteLength < size) {
          throw new Error("invalid packfile: object smaller than its declared size");
        }
        await this.skip(result.engine.bytesWritten);
        let { buffer } = result;
        // A Buffer, whose slice() aliases rather than copies; hand out a plain Uint8Array.
        if (size > 0) onData(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
        return;
      }
    }
    await this.#inflateStream(size, onData);
  }

  // inflateTo() as a stream: feeds the inflater a read at a time until it reports the zlib
  // stream's end, then positions the reader after the bytes it consumed.
  async #inflateStream(size: number, onData: (piece: Uint8Array) => void): Promise<void> {
    let inflater = createInflate();
    let total = 0;
    let failure: unknown;
    let ended = false;
    let wake = () => {};
    let fail = (err: unknown) => {
      failure ??= err;
      inflater.destroy();
      wake();
    };
    inflater.on("data", (piece: Uint8Array) => {
      if (failure !== undefined) return;
      total += piece.byteLength;
      if (total > size) {
        fail(new Error("invalid packfile: object larger than its declared size"));
        return;
      }
      try {
        onData(new Uint8Array(piece.buffer, piece.byteOffset, piece.byteLength));
      } catch (err) {
        fail(err);
      }
    });
    inflater.on("end", () => {
      ended = true;
      wake();
    });
    inflater.on("error", err => {
      failure ??= packInflateError(err);
      wake();
    });

    try {
      let fed = 0;  // bytes written to the inflater
      for (;;) {
        await this.#fill();
        let piece = this.#chunk.subarray(this.#pos);
        let fedBefore = fed;
        fed += piece.byteLength;
        // The callback runs once the inflater has consumed what of `piece` it will; one that
        // ends the zlib stream leaves the rest, and `bytesWritten` counts only what it consumed.
        await new Promise<void>(resolve => {
          wake = resolve;
          inflater.write(piece, () => resolve());
        });
        if (failure !== undefined) throw failure;
        if (ended || inflater.bytesWritten < fed) {
          // The stream has ended, though its "end", which follows the last of its output, may
          // not have been emitted yet.
          if (!ended) await new Promise<void>(resolve => { wake = resolve; });
          if (failure !== undefined) throw failure;
          this.#pos += inflater.bytesWritten - fedBefore;
          break;
        }
        this.#pos = this.#chunk.byteLength;
      }
    } finally {
      inflater.destroy();
    }

    if (total !== size) {
      throw new Error("invalid packfile: object smaller than its declared size");
    }
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

  // Reads the next bytes of the pack from the source into `view`. A read moves `view`'s buffer,
  // so `bytes` is a view of the buffer it moved to, ending with the bytes read; at the source's
  // end, when `done`, it is an empty one.
  async #read(view: Uint8Array): Promise<{ bytes: Uint8Array, done: boolean }> {
    if (this.#ended) return { bytes: view.subarray(0, 0), done: true };
    let next = await this.#reader.read(view);
    if (next.done) {
      this.#ended = true;
      // The streams standard gives the moved buffer back even here, as an empty view, but for a
      // cancelled stream (which only disposal cancels); workerd's types omit it.
      let { value } = next as { value?: Uint8Array };
      if (value === undefined) throw new Error("invalid packfile: stream cancelled");
      return { bytes: value, done: true };
    }
    this.#received += next.value.byteLength;
    if (this.#received > this.#maxSize) {
      throw new Error(`packfile exceeds the ${this.#maxSize}-byte limit`);
    }
    return { bytes: next.value, done: false };
  }

}

// =======================================================================================
// Deltas
//
// A delta (the inflated payload of an ofs-/ref-delta pack entry) is two size varints -- the
// base's and the target's -- then instructions: a copy of a byte range of the base, or an
// insert of up to 127 literal bytes carried in the delta itself.

/**
 * A delta's base, read by byte range: a whole payload (`bytesDeltaBase()`), or a stored blob read
 * a chunk at a time (a `BlobReader` is one).
 */
export interface DeltaBase {
  /** The base payload's byte length. */
  readonly size: number;

  /**
   * The `length` bytes at `offset`, a range within `size`. May be borrowed: the applier reads
   * them before its next call and never retains them.
   */
  read(offset: number, length: number): Uint8Array;
}

/** A whole payload as a delta base. */
export function bytesDeltaBase(payload: Uint8Array): DeltaBase {
  return {
    size: payload.byteLength,
    read: (offset, length) => payload.subarray(offset, offset + length),
  };
}

/**
 * Receives a delta's result in order, in pieces that are borrowed: valid only during the call.
 * A copy of the base arrives in pieces of at most DELTA_COPY_PIECE bytes.
 */
export type DeltaSink = (piece: Uint8Array) => void;

// The most of a copy instruction's range read from the base at once (a copy can span 16 MiB),
// so a large copy from a chunked base never sits in memory whole.
const DELTA_COPY_PIECE = 1 << 20;

/**
 * Applies a git delta to its base as the delta arrives, in pieces split anywhere -- mid-varint,
 * mid-instruction -- streaming the result to a sink, so that neither the delta nor the result
 * need be held whole, and the base is read only where the delta copies from it. The sink is
 * chosen once the target size is known (by `openSink`), before any output, so a caller can
 * buffer a small result and stream a large one.
 *
 * Every size and range is validated: the base size must match, each copy must lie within the
 * base, nothing may be written past the target size, op 0 is reserved, and `finish()` checks
 * that the delta ended between instructions with exactly the target size written.
 */
export class GitDeltaApplier {
  readonly #base: DeltaBase;
  readonly #openSink: (targetSize: number) => DeltaSink;
  #sink: DeltaSink | undefined;
  #targetSize: number | undefined;
  #written = 0;

  // The header: which size varint is being read (0 = the base's, 1 = the target's, 2 = done),
  // and its value so far.
  #header = 0;
  #varint = 0;
  #factor = 1;

  // The instruction in progress, if any: a copy whose argument bytes are still arriving (bits 0-3
  // of the op select offset bytes, bits 4-6 size bytes, read in bit order), or an insert with
  // literal bytes still to come.
  #copying = false;
  #copyBits = 0;
  #copyOffset = 0;
  #copySize = 0;
  #insertLeft = 0;

  constructor(base: DeltaBase, openSink: (targetSize: number) => DeltaSink) {
    this.#base = base;
    this.#openSink = openSink;
  }

  /** The result's size, once the delta's header has been read. */
  get targetSize(): number | undefined {
    return this.#targetSize;
  }

  /** Consumes the next bytes of the delta. They are read during the call and not retained. */
  push(bytes: Uint8Array): void {
    let pos = 0;
    while (pos < bytes.length) {
      if (this.#header < 2) {
        let byte = bytes[pos++];
        this.#varint += (byte & 0x7f) * this.#factor;
        this.#factor *= 128;
        if (byte & 0x80) {
          if (this.#factor > Number.MAX_SAFE_INTEGER) {
            throw new Error("invalid delta: size overflow");
          }
          continue;
        }
        let value = this.#varint;
        this.#varint = 0;
        this.#factor = 1;
        if (this.#header++ === 0) {
          if (value !== this.#base.size) throw new Error("invalid delta: base size mismatch");
        } else {
          this.#targetSize = value;
          this.#sink = this.#openSink(value);
        }
      } else if (this.#insertLeft > 0) {
        let take = Math.min(this.#insertLeft, bytes.length - pos);
        this.#emit(bytes.subarray(pos, pos + take));
        pos += take;
        this.#insertLeft -= take;
      } else if (this.#copying) {
        let bit = 31 - Math.clz32(this.#copyBits & -this.#copyBits);  // the lowest one pending
        this.#copyBits &= ~(1 << bit);
        let byte = bytes[pos++];
        if (bit < 4) this.#copyOffset += byte * 2 ** (8 * bit);
        else this.#copySize += byte * 2 ** (8 * (bit - 4));
        if (this.#copyBits === 0) this.#copy();
      } else {
        let op = bytes[pos++];
        if (op & 0x80) {
          this.#copying = true;
          this.#copyBits = op & 0x7f;
          this.#copyOffset = 0;
          this.#copySize = 0;
          if (this.#copyBits === 0) this.#copy();
        } else if (op > 0) {
          if (this.#written + op > this.#targetSize!) {
            throw new Error("invalid delta: insert out of range");
          }
          this.#insertLeft = op;
        } else {
          throw new Error("invalid delta: reserved zero op");
        }
      }
    }
  }

  /** Ends the delta, checking that it was complete. */
  finish(): void {
    if (this.#header < 2) throw new Error("invalid delta: truncated size");
    if (this.#copying) throw new Error("invalid delta: truncated copy op");
    if (this.#insertLeft > 0) throw new Error("invalid delta: insert out of range");
    if (this.#written !== this.#targetSize) throw new Error("invalid delta: result size mismatch");
  }

  #copy(): void {
    this.#copying = false;
    let offset = this.#copyOffset;
    let size = this.#copySize === 0 ? 0x10000 : this.#copySize;
    if (offset + size > this.#base.size || this.#written + size > this.#targetSize!) {
      throw new Error("invalid delta: copy out of range");
    }
    for (let done = 0; done < size;) {
      let length = Math.min(DELTA_COPY_PIECE, size - done);
      this.#emit(this.#base.read(offset + done, length));
      done += length;
    }
  }

  #emit(piece: Uint8Array): void {
    this.#written += piece.length;
    this.#sink!(piece);
  }
}

/**
 * Applies a whole git delta to a whole base, producing the target payload whole (see
 * GitDeltaApplier, which this wraps). With `maxSize`, a result larger than that is refused
 * before it is allocated.
 */
export function applyGitDelta(delta: Uint8Array, base: Uint8Array, maxSize?: number)
    : Uint8Array {
  let target = new Uint8Array(0);
  let applier = new GitDeltaApplier(bytesDeltaBase(base), size => {
    if (maxSize !== undefined && size > maxSize) {
      throw new Error(`invalid delta: result of ${size} bytes exceeds the ${maxSize}-byte limit`);
    }
    return bufferSink(target = new Uint8Array(size));
  });
  applier.push(delta);
  applier.finish();
  return target;
}

// A sink filling `target` from its start. The applier never writes past its target size.
function bufferSink(target: Uint8Array): DeltaSink {
  let filled = 0;
  return piece => {
    target.set(piece, filled);
    filled += piece.length;
  };
}
