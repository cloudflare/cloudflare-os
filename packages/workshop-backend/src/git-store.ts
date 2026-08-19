// The workspace git object store.
//
// Each workspace's Overseer DO holds a real git object database -- SHA-1, zlib-deflated loose
// objects, byte-identical to what `git` itself would write -- stored in the `gitObjects`
// typed-storage collection. Mainline gadget code is (will be, once the commit-backed code flow
// lands) represented as commits in this store, with each GadgetRecord pointing at its head
// commit.
//
// There is deliberately no ref layer: no branches, tags, or HEAD. Our "refs" are the gadget
// records, blueprint records, and chats' pinned commits, all managed by the Overseer's own
// workflow. Because the store is content-addressed and refless, unrelated histories coexist
// freely in the same collection, and related histories (gadgets forked from each other or
// instantiated from the same blueprint) deduplicate at the blob/tree level.
//
// We use real git formats (rather than a git-shaped custom encoding) so that gadget code can
// later be exported to and imported from real git repositories, and so agents can eventually
// "mount" arbitrary repos through gatekeeper-gated push/pull. isomorphic-git provides the object
// codec; we use only its plumbing (writeBlob/writeTree/writeCommit/read*/log), which operates
// against a gitdir containing nothing but `objects/**`. The porcelain is off-limits:
// `git.commit` requires HEAD/index/config, and `git.merge` cannot represent the merge behavior
// we want (see `threeWayMerge`).
//
// Storage notes:
// - Loose objects only, one collection record per object, keyed by oid. isomorphic-git never
//   writes deltified data (it only reads deltas in packfiles fetched from remotes), so each
//   record is a zlib'd whole object. Dedup comes from content addressing, not deltas.
// - No object exceeds ~2MB today (records hold single source files, small trees, and commit
//   headers). If large blobs ever appear, chunking records or spilling to R2 is a change local
//   to the fs shim below.
// - No GC. Dangling objects are only created by accepted merges, imports, and migration -- never
//   by in-flight chats -- and are cheap. If GC is ever needed, the roots are enumerable: gadget
//   records, blueprint gadget records, live chats' pinned commits, the pin declarations in chat
//   logs and compaction checkpoints (closed epochs are reconstructed from them), and the
//   `observedCommit` stamps on chats' readFile tool calls (which nothing else roots -- a future
//   GC must either root them or the agent's elision path must tolerate a missing commit by
//   eliding unconditionally).

import {
  readBlob,
  readCommit,
  readTree,
  writeBlob,
  writeCommit,
  writeTree,
  log,
  type PromiseFsClient,
  type TreeEntry,
} from "isomorphic-git";
import diff3Merge from "diff3";
import { collection, type Collection } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo, CommitIdentity, CommitInfo } from "@gadgets/workshop-shared/api";

// =======================================================================================
// Storage schema

/**
 * One git loose object: `data` is the zlib-deflated object exactly as git would store it under
 * `.git/objects/xx/yyyy...`, and `oid` is its 40-hex SHA-1 name. Content-addressed, hence
 * immutable and idempotent to rewrite.
 */
export interface GitObjectRecord {
  oid: string;
  data: Uint8Array;
}

/**
 * Typed-storage schema for a git object store collection. Shared between `makeOverseerStorage()`
 * and tests so both bind the identical schema.
 */
export function gitObjectsCollection() {
  return collection<GitObjectRecord>()({
    primaryKey: "oid",
  });
}

// =======================================================================================
// fs shim
//
// isomorphic-git's only storage interface is a filesystem. We give it a virtual one that maps
// loose-object paths onto the `gitObjects` collection and rejects everything else, so we never
// silently accept writes we didn't intend to store. If we ever need non-object paths (e.g. for
// git protocol support), that's a schema extension we design then.

/** The virtual gitdir path the fs shim serves. Only meaningful within this module and tests. */
export const GITDIR = "/git";

const LOOSE_OBJECT_PATH = new RegExp(`^${GITDIR}/objects/([0-9a-f]{2})/([0-9a-f]{38})$`);

/** Parses a loose-object path within the virtual gitdir into its 40-hex oid. */
function oidFromLoosePath(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  let match = LOOSE_OBJECT_PATH.exec(path);
  if (!match) return undefined;
  return match[1] + match[2];
}

/** Makes an Error carrying the `code` property Node-style fs consumers dispatch on. */
function fsError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/**
 * A `PromiseFsClient` backed by a `gitObjects` collection. Exposed for tests; production code
 * should use `GitStore`.
 *
 * Contract subtleties, verified against isomorphic-git 1.40:
 * - All ten methods must exist even though only `readFile`/`writeFile`/`stat`/`mkdir`/`readdir`
 *   are ever exercised for object-database work: `bindFs` binds every one unconditionally.
 * - The promise-style detection probe calls `readFile()` with no arguments and requires a
 *   promise back; `async` methods satisfy this by returning a rejected promise rather than
 *   throwing synchronously.
 * - Missing files must reject with `code: "ENOENT"`: `FileSystem.exists()` rethrows anything
 *   else, and `discoverGitdir` / `FileSystem.read` / `FileSystem.readdir` tolerate rejections
 *   (the gitdir itself, `shallow`, and `objects/pack` reads all take those paths).
 */
export function makeGitObjectsFs(objects: Collection<GitObjectRecord, string>): PromiseFsClient {
  return { promises: {
    async readFile(path: unknown): Promise<Uint8Array> {
      let oid = oidFromLoosePath(path);
      if (oid === undefined) throw fsError("ENOENT", `unsupported read: ${String(path)}`);
      let record = objects.get(oid);
      if (record === undefined) throw fsError("ENOENT", `no such object: ${oid}`);
      return record.data;
    },

    async writeFile(path: unknown, data: unknown): Promise<void> {
      let oid = oidFromLoosePath(path);
      if (oid === undefined) throw fsError("EPERM", `unsupported write: ${String(path)}`);
      if (!(data instanceof Uint8Array)) throw fsError("EINVAL", "expected binary object data");
      // Copy: the input is typically a Buffer view over a shared pool, and the record outlives
      // the call.
      objects.put({ oid, data: new Uint8Array(data) });
    },

    async stat(path: unknown): Promise<{
      isFile(): boolean;
      isDirectory(): boolean;
      isSymbolicLink(): boolean;
      size: number;
    }> {
      // Only existing loose objects stat successfully. The gitdir itself rejecting is fine:
      // discoverGitdir treats a failed stat as "neither file nor directory" and uses the path
      // as-is.
      let oid = oidFromLoosePath(path);
      let record = oid === undefined ? undefined : objects.get(oid);
      if (record === undefined) throw fsError("ENOENT", `no such file: ${String(path)}`);
      let size = record.data.byteLength;
      return {
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        size,
      };
    },

    async mkdir(_path: unknown): Promise<void> {
      // Directories don't exist in this store; object writes succeed without them. Accept and
      // ignore so `FileSystem.write`'s mkdirp fallback can't fail.
    },

    async readdir(path: unknown): Promise<string[]> {
      // The packed-object probe lists `objects/pack`; we store no packfiles, so it's empty.
      if (path === `${GITDIR}/objects/pack`) return [];
      throw fsError("ENOENT", `unsupported readdir: ${String(path)}`);
    },

    // Never used for object-database work, but bindFs requires them to exist.
    async lstat(path: unknown): Promise<never> {
      throw fsError("ENOSYS", `lstat unsupported by git-store: ${String(path)}`);
    },
    async unlink(path: unknown): Promise<never> {
      throw fsError("ENOSYS", `unlink unsupported by git-store: ${String(path)}`);
    },
    async rmdir(path: unknown): Promise<never> {
      throw fsError("ENOSYS", `rmdir unsupported by git-store: ${String(path)}`);
    },
    async readlink(path: unknown): Promise<never> {
      throw fsError("ENOSYS", `readlink unsupported by git-store: ${String(path)}`);
    },
    async symlink(path: unknown): Promise<never> {
      throw fsError("ENOSYS", `symlink unsupported by git-store: ${String(path)}`);
    },
  } };
}

// =======================================================================================
// GitStore

/** Options for `GitStore.writeFilesAsCommit()`. */
export interface WriteCommitOptions {
  /** Parent commit oids; empty for a root commit. */
  parents: string[];

  /** Commit author. Also used as the committer unless `committer` is given. */
  author: CommitIdentity;

  /** Committer, when distinct from the author. */
  committer?: CommitIdentity;

  /** Commit message. Normalized git-style to end with exactly one newline. */
  message: string;

  /** Author and committer timestamp. Recorded in UTC (timezone offset 0). */
  timestamp: Date;
}

// A parsed-but-unwritten tree: file contents at the leaves, subtrees within.
type TreeNode = Map<string, TreeNode | string>;

/**
 * A git object database over a `gitObjects` collection.
 *
 * This is plumbing only: it reads and writes blobs/trees/commits by oid and knows nothing about
 * refs -- callers (gadget records, blueprint records, chat pins) track which commits matter.
 * Files are presented as flat `path -> text` maps; paths may contain `/`, which maps to nested
 * trees so stored history stays interoperable with real git tooling.
 *
 * Construct one per Overseer instance and reuse it: it carries isomorphic-git's parse cache.
 */
export class GitStore {
  #fs: PromiseFsClient;
  #cache: object = {};

  constructor(objects: Collection<GitObjectRecord, string>) {
    this.#fs = makeGitObjectsFs(objects);
  }

  /**
   * Writes `files` (a `path -> text` map) as a commit, returning the commit oid. All objects are
   * content-addressed, so rewriting identical content is a cheap no-op that produces the same
   * oids.
   */
  async writeFilesAsCommit(
      files: ReadonlyMap<string, string>, options: WriteCommitOptions): Promise<string> {
    let tree = await this.#writeTreeNode(buildTreeNode(files));
    let when = { timestamp: Math.floor(options.timestamp.getTime() / 1000), timezoneOffset: 0 };
    return await writeCommit({
      fs: this.#fs,
      gitdir: GITDIR,
      commit: {
        message: options.message,
        tree,
        parent: [...options.parents],
        author: { ...options.author, ...when },
        committer: { ...(options.committer ?? options.author), ...when },
      },
    });
  }

  /**
   * Reads back the full file map of a commit: the inverse of `writeFilesAsCommit()`, with nested
   * trees flattened to `/`-joined paths.
   *
   * Only regular-file blobs (modes 100644/100755) are supported; symlinks and submodules --
   * which we never write, but an imported history could contain -- are rejected rather than
   * misread.
   */
  async readCommitFiles(oid: string): Promise<Map<string, string>> {
    let { commit } = await readCommit({ fs: this.#fs, gitdir: GITDIR, oid, cache: this.#cache });
    let files = new Map<string, string>();
    await this.#collectTreeFiles(commit.tree, "", files);
    return files;
  }

  /**
   * Reads a commit's tree as a `path -> blob oid` map (flattened like `readCommitFiles`, but
   * without touching blob content). Content addressing makes this the cheap way to ask which
   * files differ between two commits -- see `changedPaths`.
   */
  async commitFileOids(oid: string): Promise<Map<string, string>> {
    let { commit } = await readCommit({ fs: this.#fs, gitdir: GITDIR, oid, cache: this.#cache });
    let out = new Map<string, string>();
    await this.#collectTreeOids(commit.tree, "", out);
    return out;
  }

  /**
   * The set of file paths whose content differs between two commits' trees (added, removed, or
   * changed), compared by oid -- equal subtrees short-circuit without descending, and no blob
   * content is ever read. `undefined` on either side means an empty tree, so a one-sided call
   * lists a commit's whole tree.
   */
  async changedPaths(a: string | undefined, b: string | undefined): Promise<Set<string>> {
    let changed = new Set<string>();
    if (a === b) return changed;
    let treeOf = async (oid: string | undefined) => oid === undefined ? undefined
        : (await readCommit({ fs: this.#fs, gitdir: GITDIR, oid, cache: this.#cache }))
            .commit.tree;
    await this.#diffTrees(await treeOf(a), await treeOf(b), "", changed);
    return changed;
  }

  // Accumulates the paths that differ between two trees (either may be absent = empty) into
  // `out`. Entries are matched by name; a name that is a blob on one side and a tree on the
  // other contributes every path under both sides.
  async #diffTrees(aOid: string | undefined, bOid: string | undefined, prefix: string,
                   out: Set<string>): Promise<void> {
    if (aOid === bOid) return;
    let entriesOf = async (oid: string | undefined) => {
      if (oid === undefined) return new Map<string, TreeEntry>();
      let { tree } = await readTree({ fs: this.#fs, gitdir: GITDIR, oid, cache: this.#cache });
      return new Map(tree.map(entry => [entry.path, entry]));
    };
    let aEntries = await entriesOf(aOid);
    let bEntries = await entriesOf(bOid);
    for (let name of new Set([...aEntries.keys(), ...bEntries.keys()])) {
      let a = aEntries.get(name);
      let b = bEntries.get(name);
      if (a?.oid === b?.oid && a?.type === b?.type) continue;
      let path = prefix + name;
      if (a?.type === "tree" || b?.type === "tree") {
        // Descend the tree side(s); a blob opposite a tree is one more difference at `path`.
        await this.#diffTrees(a?.type === "tree" ? a.oid : undefined,
                              b?.type === "tree" ? b.oid : undefined, `${path}/`, out);
        if (a?.type === "blob" || b?.type === "blob") out.add(path);
      } else {
        out.add(path);
      }
    }
  }

  /**
   * Walks the commit graph from `oid` (the commit itself first, then its ancestry), returning up
   * to `depth` commits' metadata. Traversal order for merge commits follows git log's default
   * (reverse chronological).
   */
  async readCommitLog(oid: string, options: { depth?: number } = {}): Promise<CommitInfo[]> {
    let entries = await log({
      fs: this.#fs,
      gitdir: GITDIR,
      ref: oid,
      depth: options.depth,
      cache: this.#cache,
    });
    return entries.map(entry => ({
      oid: entry.oid,
      parents: entry.commit.parent,
      message: entry.commit.message,
      author: { name: entry.commit.author.name, email: entry.commit.author.email },
      timestamp: new Date(entry.commit.author.timestamp * 1000),
    }));
  }

  async #writeTreeNode(node: TreeNode): Promise<string> {
    let entries: TreeEntry[] = [];
    for (let [name, child] of node) {
      if (typeof child === "string") {
        let oid = await writeBlob({
          fs: this.#fs,
          gitdir: GITDIR,
          blob: new TextEncoder().encode(child),
        });
        entries.push({ mode: "100644", path: name, oid, type: "blob" });
      } else {
        let oid = await this.#writeTreeNode(child);
        entries.push({ mode: "040000", path: name, oid, type: "tree" });
      }
    }
    // isomorphic-git sorts entries into git's canonical tree order itself.
    return await writeTree({ fs: this.#fs, gitdir: GITDIR, tree: entries });
  }

  // The oid-level analog of #collectTreeFiles: flattens a tree to `path -> blob oid` without
  // reading any blob. Applies the same mode restriction, so the two views can never disagree
  // about which paths exist.
  async #collectTreeOids(
      treeOid: string, prefix: string, out: Map<string, string>): Promise<void> {
    let { tree } = await readTree(
        { fs: this.#fs, gitdir: GITDIR, oid: treeOid, cache: this.#cache });
    for (let entry of tree) {
      let path = prefix + entry.path;
      if (entry.type === "tree") {
        await this.#collectTreeOids(entry.oid, `${path}/`, out);
      } else if (entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755")) {
        out.set(path, entry.oid);
      } else {
        throw new Error(`unsupported tree entry at ${path}: mode ${entry.mode}`);
      }
    }
  }

  async #collectTreeFiles(
      treeOid: string, prefix: string, out: Map<string, string>): Promise<void> {
    let { tree } = await readTree(
        { fs: this.#fs, gitdir: GITDIR, oid: treeOid, cache: this.#cache });
    for (let entry of tree) {
      let path = prefix + entry.path;
      if (entry.type === "tree") {
        await this.#collectTreeFiles(entry.oid, `${path}/`, out);
      } else if (entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755")) {
        let { blob } = await readBlob(
            { fs: this.#fs, gitdir: GITDIR, oid: entry.oid, cache: this.#cache });
        out.set(path, new TextDecoder().decode(blob));
      } else {
        throw new Error(`unsupported tree entry at ${path}: mode ${entry.mode}`);
      }
    }
  }
}

// Converts a flat `path -> text` map into nested tree nodes, validating path shape as we go:
// git can't represent empty segments or "."/"..", and a path can't be both a file and a
// directory.
function buildTreeNode(files: ReadonlyMap<string, string>): TreeNode {
  let root: TreeNode = new Map();
  for (let [path, content] of files) {
    let segments = path.split("/");
    let node = root;
    for (let [i, segment] of segments.entries()) {
      if (segment === "" || segment === "." || segment === "..") {
        throw new Error(`invalid file path: ${path}`);
      }
      let last = i === segments.length - 1;
      let existing = node.get(segment);
      if (last) {
        if (existing !== undefined) throw new Error(`conflicting file paths at: ${path}`);
        node.set(segment, content);
      } else {
        if (existing === undefined) {
          existing = new Map();
          node.set(segment, existing);
        } else if (typeof existing === "string") {
          throw new Error(`conflicting file paths at: ${path}`);
        }
        node = existing;
      }
    }
  }
  return root;
}

/** Compares two flattened file maps for identical content. */
export function filesEqual(
    a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (let [name, content] of a) {
    if (b.get(name) !== content) return false;
  }
  return true;
}

// =======================================================================================
// Three-way merge

/** Labels for the three sides of a merge, rendered into conflict markers. */
export interface MergeLabels {
  base?: string;
  ours?: string;
  theirs?: string;
}

/** The result of `threeWayMerge()`. */
export interface MergeResult {
  /** The merged file map, including any files containing conflict markers. */
  files: Map<string, string>;

  /**
   * Paths whose merge was not clean, in sorted order. Content conflicts carry inline 3-way
   * markers; delete-vs-modify conflicts keep the modified content with no markers.
   */
  conflictPaths: string[];
}

/**
 * Merges three file maps: `base` is the common ancestor, `ours` and `theirs` the two sides.
 * Never throws on conflict -- conflicted files get inline 3-way markers
 * (`<<<<<<<`/`|||||||`/`=======`/`>>>>>>>`, diff3 style) and are reported in `conflictPaths`,
 * for the user or their agent to clean up.
 *
 * This deliberately replaces both Yjs merging (CRDT merge across divergent bases produces
 * nonsense) and isomorphic-git's `merge`/`mergeTree` (which throw on both-sides-added conflicts
 * before any merge driver runs, and require an index). The common ancestor is always explicitly
 * known in our workflow -- the chat's last merged commit -- so no merge-base discovery is
 * needed.
 *
 * Per-file semantics:
 * - changed on one side only (including deletion): that side wins;
 * - identical change on both sides (including both deleted): clean;
 * - deleted on one side, changed on the other: the changed content survives, reported as a
 *   conflict;
 * - changed on both sides (including both-added): line merged via diff3, conflicting hunks
 *   marked.
 */
export function threeWayMerge(
    base: ReadonlyMap<string, string>,
    ours: ReadonlyMap<string, string>,
    theirs: ReadonlyMap<string, string>,
    labels: MergeLabels = {}): MergeResult {
  let files = new Map<string, string>();
  let conflictPaths: string[] = [];

  let allPaths = [...new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])].toSorted();
  for (let path of allPaths) {
    let b = base.get(path);
    let o = ours.get(path);
    let t = theirs.get(path);

    if (o === t) {
      // Identical on both sides (possibly both deleted, possibly an identical add).
      if (o !== undefined) files.set(path, o);
    } else if (o === b) {
      // Only theirs changed (possibly a deletion).
      if (t !== undefined) files.set(path, t);
    } else if (t === b) {
      // Only ours changed (possibly a deletion).
      if (o !== undefined) files.set(path, o);
    } else if (o === undefined || t === undefined) {
      // Deleted on one side, changed on the other: keep the modified content.
      files.set(path, (o ?? t)!);
      conflictPaths.push(path);
    } else {
      // Changed on both sides (b === undefined means both-added with different content; diff3
      // against an empty base marks the entirety of both sides as conflicting).
      let merged = mergeText(b ?? "", o, t, labels);
      files.set(path, merged.text);
      if (!merged.clean) conflictPaths.push(path);
    }
  }

  return { files, conflictPaths };
}

// A zero-width boundary after every "\n"; split() then keeps each terminator with its line.
const LINE_BOUNDARY = /(?<=\n)/;

/**
 * Split `text` into lines, each keeping its trailing "\n", so `lines.join("") === text` always
 * holds. The consumer -- the diff3 merge below -- reassembles content from the pieces it
 * computes over, so the split must be
 * lossless above all: only "\n" ends a line, and a bare "\r" (or U+2028/U+2029) stays *inside*
 * its line rather than acting as a boundary, which merely makes diffs and merges of such exotic
 * line endings coarser -- whereas the obvious `/^.*$/m`-style split treats those characters as
 * boundaries it cannot retain, silently corrupting any content that uses them. A boundary
 * always follows "\n", so it can never split a UTF-16 surrogate pair.
 */
export function splitLines(text: string): string[] {
  return text === "" ? [] : text.split(LINE_BOUNDARY);
}

// A conflict hunk at end-of-file may lack a trailing newline; give it one so the following
// marker starts its own line. (isomorphic-git glues the marker onto the last line instead.)
function withFinalNewline(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

function mergeText(base: string, ours: string, theirs: string, labels: MergeLabels):
    { clean: boolean, text: string } {
  // diff3 operates on arrays of lines; splitLines keeps each line's terminator, so join("")
  // reassembles losslessly. (isomorphic-git's mergeFile splits with a regex that treats bare
  // "\r"/U+2028/U+2029 as boundaries it then drops, corrupting content that uses them; ours
  // keeps such characters inside their line instead.)
  let regions = diff3Merge(
      splitLines(ours), splitLines(base), splitLines(theirs));

  let clean = true;
  let text = "";
  for (let region of regions) {
    if ("ok" in region) {
      text += region.ok.join("");
    } else {
      clean = false;
      text += `<<<<<<< ${labels.ours ?? "ours"}\n`;
      text += withFinalNewline(region.conflict.a.join(""));
      text += `||||||| ${labels.base ?? "base"}\n`;
      text += withFinalNewline(region.conflict.o.join(""));
      text += "=======\n";
      text += withFinalNewline(region.conflict.b.join(""));
      text += `>>>>>>> ${labels.theirs ?? "theirs"}\n`;
    }
  }
  return { clean, text };
}

// =======================================================================================
// Commit identity

/**
 * Derives a git commit identity from a chat author: the display name becomes the commit name,
 * and the profile ID the email. Profile IDs are typically email addresses; in username/password
 * mode they may be bare usernames, which become `<username>@localhost`. (A placeholder
 * convention until users can customize their commit identity.)
 */
export function commitIdentityForAuthor(author: AiChatAuthorInfo): CommitIdentity {
  return {
    name: author.name,
    email: author.id.includes("@") ? author.id : `${author.id}@localhost`,
  };
}
