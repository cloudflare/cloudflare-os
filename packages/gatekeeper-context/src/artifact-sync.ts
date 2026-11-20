import { posix as posixPath } from "node:path";
import {
  MAX_DOCUMENT_BODY_BYTES, contentTypeFromPath, isTextContentType, VENDOR_ID,
} from "./context-types.js";
import { truncateContextDescription } from "./context-storage.js";
import { extractDescription } from "./description-extractors.js";
import { mapWithConcurrency } from "./concurrency.js";
import { obsContext } from "./observability.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.context", vendorId: VENDOR_ID,
});

// Folder listings in flight at once while walking a commit's tree.
const MAX_TREE_READS_IN_FLIGHT = 8;
// File reads in flight at once. Artifacts holds files of up to 32 MiB and returns each one whole,
// and a file's size is known only once it arrives, so two reads hold at most 64 MiB of the
// isolate's 128 MB.
const MAX_BLOB_READS_IN_FLIGHT = 2;

// Tree entries mirrored as documents, as `git ls-files` lists them: regular and executable files,
// and symlinks, whose body is the link target. A submodule (gitlink) has no content in this repo.
const FILE_ENTRY_TYPES: ReadonlySet<ArtifactsTreeEntryType> = new Set(["blob", "exec", "symlink"]);

export type ArtifactContextDocument = {
  path: string;
  name: string;
  description: string;
  contentType: string;
  body: Uint8Array;
  lastUpdated: Date;
  /** Git blob hash of `body`, so a later sync skips the file while its hash is unchanged. */
  gitBlobHash: string;
};

export function artifactContextDocument(path: string, blob: Uint8Array, blobHash: string): ArtifactContextDocument {
  let contentType = contentTypeFromPath(path);
  let body = isTextContentType(contentType) ? new TextDecoder().decode(blob) : undefined;
  return {
    path,
    name: posixPath.basename(path),
    description: truncateContextDescription(
      body === undefined ? "" : extractDescription(contentType, body) ?? "",
    ),
    contentType,
    body: blob,
    lastUpdated: new Date(),
    gitBlobHash: blobHash,
  };
}

/** Git's object ID for a blob holding `bytes`. */
export async function gitBlobHash(bytes: Uint8Array): Promise<string> {
  let header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  let object = new Uint8Array(header.byteLength + bytes.byteLength);
  object.set(header);
  object.set(bytes, header.byteLength);
  let digest = new Uint8Array(await crypto.subtle.digest("SHA-1", object));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

export type ArtifactRepoReadResult =
  | { commit: string; changed: false }
  | {
    commit: string;
    changed: true;
    /** Blob hash of every file at `commit`, by path. Each was held already or has been staged. */
    files: Map<string, string>;
  };

/** Where a sync finds the files the collection already holds and keeps the ones it reads. */
export type ArtifactSyncStore = {
  /**
   * Blob hashes of the copies held for each path, published or staged. Files whose hash is among
   * them aren't read again.
   */
  heldBlobHashes(): Promise<ReadonlyMap<string, ReadonlySet<string>>>;
  /** Keeps a file read from the new commit until the whole commit has been read. */
  stage(document: ArtifactContextDocument): void;
};

type TreeFile = { path: string; hash: string };

/**
 * Reads the tip of `branch` in the collection's repo, if it differs from `currentCommit`, staging
 * each file whose blob hash differs from the copy `store` holds. Files too large to keep as
 * documents are skipped.
 */
export function readArtifactRepoDocuments(
  artifacts: Artifacts,
  repoName: string,
  branch: string,
  currentCommit: string | undefined,
  store: ArtifactSyncStore,
): Promise<ArtifactRepoReadResult> {
  return obsContext.with({
    operation: "artifacts.repo.read", repoName, branch,
  }, () => readArtifactRepoDocumentsWithContext(artifacts, repoName, branch, currentCommit, store));
}

async function readArtifactRepoDocumentsWithContext(
  artifacts: Artifacts,
  repoName: string,
  branch: string,
  currentCommit: string | undefined,
  store: ArtifactSyncStore,
): Promise<ArtifactRepoReadResult> {
  using repo = await artifacts.get(repoName);
  // A full ref name, so a tag named like the branch can't stand in for it.
  let [tip] = await repo.log({ ref: `refs/heads/${branch}`, limit: 1 });
  if (!tip) {
    return currentCommit === ""
      ? { commit: "", changed: false }
      : { commit: "", changed: true, files: new Map() };
  }
  if (tip.hash === currentCommit) return { commit: tip.hash, changed: false };

  let held = await store.heldBlobHashes();
  let files = new Map<string, string>();
  let toRead: TreeFile[] = [];
  for (let file of await listTreeFiles(repo, tip.treeHash)) {
    files.set(file.path, file.hash);
    if (!held.get(file.path)?.has(file.hash)) toRead.push(file);
  }

  await mapWithConcurrency(toRead, MAX_BLOB_READS_IN_FLIGHT, async (file) => {
    let blob = await readFileBlob(repo, file);
    if (!blob) return;
    let body = new Uint8Array(await blob.arrayBuffer());
    store.stage(artifactContextDocument(file.path, body, file.hash));
  });
  return { commit: tip.hash, changed: true, files };
}

// Every file in a tree and its subtrees, read one directory level at a time.
async function listTreeFiles(repo: ArtifactsRepo, rootHash: string): Promise<TreeFile[]> {
  let files: TreeFile[] = [];
  let level: TreeFile[] = [{ path: "", hash: rootHash }];
  while (level.length > 0) {
    let listings = await mapWithConcurrency(level, MAX_TREE_READS_IN_FLIGHT, async (tree) => {
      let entries = await repo.readTree(tree.hash);
      if (!entries) throw new Error(`Git tree ${tree.hash} is missing.`);
      return entries.map(entry => ({
        ...entry, path: tree.path ? `${tree.path}/${entry.name}` : entry.name,
      }));
    });
    level = [];
    for (let entry of listings.flat()) {
      if (entry.type === "tree") level.push({ path: entry.path, hash: entry.hash });
      else if (FILE_ENTRY_TYPES.has(entry.type)) files.push({ path: entry.path, hash: entry.hash });
    }
  }
  return files;
}

// A file's content, or undefined for a file too large to keep as a document.
async function readFileBlob(repo: ArtifactsRepo, file: TreeFile): Promise<Blob | undefined> {
  let blob: Blob | null;
  try {
    blob = await repo.readBlob(file.hash);
  } catch (err) {
    // Artifacts refuses to buffer a very large blob; such a file is skipped like any oversized one.
    if (!isArtifactsError(err, "MEMORY_LIMIT")) throw err;
    skipOversized(file.path);
    return undefined;
  }
  if (!blob) throw new Error(`Git blob ${file.hash} at ${file.path} is missing.`);
  if (blob.size > MAX_DOCUMENT_BODY_BYTES) {
    skipOversized(file.path, blob.size);
    return undefined;
  }
  return blob;
}

function skipOversized(filepath: string, bodyBytes?: number): void {
  logger.warn("skipping oversized mirrored context file", {
    event: "context.file.oversized.skipped",
    filepath,
    bodyBytes,
    maxBodyBytes: MAX_DOCUMENT_BODY_BYTES,
  });
}

function isArtifactsError(err: unknown, code: ArtifactsErrorCode): boolean {
  return err instanceof Error && "code" in err && err.code === code;
}
