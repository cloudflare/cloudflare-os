// An in-memory stand-in for an Artifacts repo's read methods, for git-backed collection tests.

import { gitBlobHash } from "../src/artifact-sync.js";

/** A file as pushed: text or bytes, or an executable, a symlink, or a submodule. */
export type FakeGitFile =
  | string
  | Uint8Array
  | { exec: string }
  | { symlink: string }
  | { gitlink: string };

type FakeBlob = Pick<Blob, "size" | "arrayBuffer">;

async function sha1(value: string | Uint8Array): Promise<string> {
  let bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function fileContent(file: FakeGitFile): { type: ArtifactsTreeEntryType; bytes?: Uint8Array; hash?: string } {
  if (typeof file === "string") return { type: "blob", bytes: new TextEncoder().encode(file) };
  if (file instanceof Uint8Array) return { type: "blob", bytes: file };
  if ("exec" in file) return { type: "exec", bytes: new TextEncoder().encode(file.exec) };
  if ("symlink" in file) return { type: "symlink", bytes: new TextEncoder().encode(file.symlink) };
  return { type: "gitlink", hash: file.gitlink };
}

const MODES: Record<ArtifactsTreeEntryType, string> = {
  blob: "100644", exec: "100755", symlink: "120000", gitlink: "160000", tree: "40000",
};

/**
 * Branches, commits, trees and blobs, with a record of every read made through `binding`. Blobs have
 * their real git hashes; trees and commits have stand-ins.
 */
export class FakeGitRepo {
  branches = new Map<string, ArtifactsCommitMetadata>();
  trees = new Map<string, ArtifactsTreeEntry[]>();
  blobs = new Map<string, FakeBlob>();
  logRefs: string[] = [];
  treeReads: string[] = [];
  blobReads: string[] = [];
  disposed = 0;
  /** Thrown by the next `log` call, then cleared. */
  failNextLog?: Error;
  /** Thrown by `readBlob` for these blob hashes. */
  blobErrors = new Map<string, Error>();
  /** Awaited by every `readTree` call while set, to hold a sync part way through. */
  treeGate?: Promise<void>;
  /** Awaited by every `readBlob` call while set, so reads in flight overlap. */
  blobDelay?: () => Promise<void>;
  /** Most `readBlob` calls that were in flight at once. */
  maxBlobReadsInFlight = 0;
  #blobReadsInFlight = 0;
  #commits = 0;
  #commitsByHash = new Map<string, ArtifactsCommitMetadata>();

  /** Commits `files` as the whole tree of `branch` and returns the commit hash. */
  async push(branch: string, files: Record<string, FakeGitFile>): Promise<string> {
    let treeHash = await this.#writeTree(Object.entries(files));
    let commit = await sha1(`commit ${this.#commits++} ${treeHash}`);
    let metadata: ArtifactsCommitMetadata = {
      hash: commit, treeHash, message: "", parents: [],
      author: { name: "", email: "" }, committer: { name: "", email: "" },
      authoredAt: 0, committedAt: 0,
    };
    this.#commitsByHash.set(commit, metadata);
    this.branches.set(branch, metadata);
    return commit;
  }

  /** Moves `branch` back to an earlier commit, as a force push would. */
  resetBranch(branch: string, commit: string): void {
    let metadata = this.#commitsByHash.get(commit);
    if (!metadata) throw new Error(`No commit ${commit}.`);
    this.branches.set(branch, metadata);
  }

  /** The blob hash `file` gets when pushed. */
  async hashOf(file: FakeGitFile): Promise<string> {
    let content = fileContent(file);
    return content.hash ?? await gitBlobHash(content.bytes!);
  }

  async #writeTree(files: Array<[string, FakeGitFile]>): Promise<string> {
    let children = new Map<string, Array<[string, FakeGitFile]>>();
    let entries: ArtifactsTreeEntry[] = [];
    for (let [path, file] of files) {
      let slash = path.indexOf("/");
      if (slash >= 0) {
        let dir = path.slice(0, slash);
        children.set(dir, [...children.get(dir) ?? [], [path.slice(slash + 1), file]]);
        continue;
      }
      let content = fileContent(file);
      let hash = content.hash ?? await gitBlobHash(content.bytes!);
      if (content.bytes) this.blobs.set(hash, new Blob([content.bytes]));
      entries.push({ name: path, mode: MODES[content.type], hash, type: content.type });
    }
    for (let [dir, nested] of children) {
      entries.push({ name: dir, mode: MODES.tree, hash: await this.#writeTree(nested), type: "tree" });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    let hash = await sha1(`tree ${JSON.stringify(entries)}`);
    this.trees.set(hash, entries);
    return hash;
  }

  repo(): ArtifactsRepo {
    return {
      log: async (opts?: { ref?: string; limit?: number }) => {
        this.logRefs.push(opts?.ref ?? "HEAD");
        let failure = this.failNextLog;
        this.failNextLog = undefined;
        if (failure) throw failure;
        // As in Artifacts, only a bare branch name or a commit hash resolves; a full ref name such as
        // `refs/heads/main` finds no commits.
        let ref = opts?.ref ?? "main";
        let tip = this.branches.get(ref) ?? this.#commitsByHash.get(ref);
        return tip ? [tip] : [];
      },
      readTree: async (hash: string) => {
        this.treeReads.push(hash);
        await this.treeGate;
        return this.trees.get(hash) ?? null;
      },
      readBlob: async (hash: string) => {
        this.blobReads.push(hash);
        this.maxBlobReadsInFlight = Math.max(this.maxBlobReadsInFlight, ++this.#blobReadsInFlight);
        try {
          await this.blobDelay?.();
          let error = this.blobErrors.get(hash);
          if (error) throw error;
          return (this.blobs.get(hash) ?? null) as Blob | null;
        } finally {
          this.#blobReadsInFlight--;
        }
      },
      // A new collection revokes the repo's initial token.
      revokeToken: async () => true,
      [Symbol.dispose]: () => { this.disposed++; },
    } as unknown as ArtifactsRepo;
  }

  /** An Artifacts binding whose every repo is this one. */
  binding(): Artifacts {
    return {
      create: async (name: string) => ({ remote: `https://artifacts.example/${name}.git`, token: "initial" }),
      get: async () => this.repo(),
      delete: async () => {},
    } as unknown as Artifacts;
  }
}

/** An Artifacts error as the binding throws it. */
export function artifactsError(code: ArtifactsErrorCode): Error {
  return Object.assign(new Error(`Artifacts error: ${code}`), { name: "ArtifactsError", code });
}
