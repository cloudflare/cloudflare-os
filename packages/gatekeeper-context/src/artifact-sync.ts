import { clone, fetch, listFiles as listGitFiles, listServerRefs, readBlob, resolveRef } from "isomorphic-git";
import { request as baseHttpRequest } from "isomorphic-git/http/web";
import type { GitHttpResponse, HttpClient } from "isomorphic-git/http/web";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import { posix as posixPath } from "node:path";
import {
  MAX_DOCUMENT_BODY_BYTES, contentTypeFromPath, isTextContentType, VENDOR_ID,
} from "./context-types.js";
import { truncateContextDescription } from "./context-storage.js";
import { extractDescription } from "./description-extractors.js";
import { obsContext } from "./observability.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.context", vendorId: VENDOR_ID,
});

// Maximum packed git repository size that can be loaded into memory
// during clone or fetch. This is a soft limit since additional
// index files may be written to the in-memory filesystem alongside
// repository content.
//
// This is not a limit on unpacked content size. Repositories containing
// content that compresses efficiently may be significantly larger than
// this limit when unpacked.
const MAX_GIT_DIR_BYTES = 64 * 1024 * 1024;

class GitTransferTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Repository too large: Git transfer exceeded ${maxBytes} bytes.`);
    this.name = "GitTransferTooLargeError";
  }
}

async function* limitBody(body: AsyncIterableIterator<Uint8Array>, maxBytes: number): AsyncIterableIterator<Uint8Array> {
  let seenBytes = 0;
  for await (let chunk of body) {
    seenBytes += chunk.byteLength;
    if (seenBytes > maxBytes) throw new GitTransferTooLargeError(maxBytes);
    yield chunk;
  }
}

// Creates a wrapped HTTP client implementation that enforces transfer
// size limits.
function makeHttp(maxBytes: number): HttpClient {
  return {
    async request(request): Promise<GitHttpResponse> {
      let response = await baseHttpRequest(request);
      return response.body
        ? { ...response, body: limitBody(response.body, maxBytes) }
        : response;
    },
  };
}

async function dirSizeBytes(dir: string): Promise<number> {
  let entries = await fsp.readdir(dir, { withFileTypes: true }).catch((err) => {
    if (isEnoent(err)) return [];
    throw err;
  });
  let size = 0;
  for (let entry of entries) {
    let path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      size += await dirSizeBytes(path);
    } else if (entry.isFile()) {
      size += await fsp.stat(path).then(stat => stat.size, (err) => {
        if (isEnoent(err)) return 0;
        throw err;
      });
    }
  }
  return size;
}

async function gitdirStats(dir: string): Promise<{ exists: boolean; sizeBytes: number }> {
  let exists = await fsp.stat(`${dir}/.git`).then(stat => stat.isDirectory(), () => false);
  return {
    exists,
    sizeBytes: exists ? await dirSizeBytes(dir) : 0,
  };
}

async function deleteCachedRepo(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true }).catch((cleanupErr) => {
    if (isEnoent(cleanupErr)) return;
    logger.warn("failed to clean up Artifacts git cache", {
      event: "artifacts.git.cache.cleanup.failed",
      dir,
      error: cleanupErr,
    });
  });
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

export type ArtifactContextDocument = {
  path: string;
  name: string;
  description: string;
  contentType: string;
  body: Uint8Array;
  lastUpdated: Date;
};

export function artifactContextDocument(path: string, blob: Uint8Array): ArtifactContextDocument {
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
  };
}

export type ArtifactRepoReadResult =
  | { commit: string; changed: true; documents: ArtifactContextDocument[] }
  | { commit: string; changed: false };

async function cloneRepo(dir: string, url: string, branch: string, onAuth: () => { username: string; password: string }): Promise<void> {
  try {
    await fsp.mkdir(dir, { recursive: true });
    await clone({
      fs,
      http: makeHttp(MAX_GIT_DIR_BYTES),
      dir,
      url,
      ref: branch,
      singleBranch: true,
      depth: 1,
      noCheckout: true,
      noTags: true,
      onAuth,
    });
  } catch (err) {
    logger.warn("artifacts git clone failed; cleaning up partial clone", {
      event: "artifacts.git.clone.failed",
      dir,
      error: err,
    });
    await deleteCachedRepo(dir);
    throw err;
  }
}

async function recloneRepo(dir: string, url: string, branch: string, onAuth: () => { username: string; password: string }): Promise<string> {
  await deleteCachedRepo(dir);
  await cloneRepo(dir, url, branch, onAuth);
  return resolveRef({ fs, dir, ref: "HEAD" });
}

async function fetchRepo(dir: string, url: string, branch: string, onAuth: () => { username: string; password: string }, maxBytes: number): Promise<string> {
  let result = await fetch({
    fs,
    http: makeHttp(maxBytes),
    dir,
    url,
    ref: branch,
    singleBranch: true,
    depth: 1,
    prune: true,
    onAuth,
  });
  if (!result.fetchHead) throw new Error("Git fetch did not return a commit.");
  return result.fetchHead;
}

async function fetchOrRecloneRepo(dir: string, url: string, branch: string, onAuth: () => { username: string; password: string }): Promise<string> {
  let { sizeBytes } = await gitdirStats(dir);
  let remainingBytes = MAX_GIT_DIR_BYTES - sizeBytes;
  if (remainingBytes <= 0) {
    logger.warn("artifacts git cache exceeded transfer budget; recloning shallow cache", {
      event: "artifacts.git.cache.transfer.budget.exceeded",
      dir,
      sizeBytes,
      maxGitDirBytes: MAX_GIT_DIR_BYTES,
    });
    return recloneRepo(dir, url, branch, onAuth);
  }

  try {
    return await fetchRepo(dir, url, branch, onAuth, remainingBytes);
  } catch (err) {
    logger.warn("artifacts git fetch failed; cleaning up before recloning", {
      event: "artifacts.git.fetch.failed",
      dir,
      error: err,
    });
    return recloneRepo(dir, url, branch, onAuth);
  }
}

export function readArtifactRepoDocuments(
  artifacts: Artifacts,
  repoName: string,
  url: string,
  branch: string,
  currentCommit?: string,
): Promise<ArtifactRepoReadResult> {
  const dir = `/tmp/artifacts/${repoName}`;
  return obsContext.with({
    operation: "artifacts.repo.read", repoName, branch, dir,
  }, () => readArtifactRepoDocumentsWithContext(
      artifacts, repoName, url, branch, dir, currentCommit));
}

async function readArtifactRepoDocumentsWithContext(
  artifacts: Artifacts,
  repoName: string,
  url: string,
  branch: string,
  dir: string,
  currentCommit?: string,
): Promise<ArtifactRepoReadResult> {
  let repo = await artifacts.get(repoName);
  // Create a temporary read token just for this function call.
  let token = await repo.createToken("read", 3600);

  try {
    let onAuth = () => ({ username: "x-access-token", password: token.plaintext });
    let branchRefName = `refs/heads/${branch}`;
    let refs = await listServerRefs({ http: makeHttp(MAX_GIT_DIR_BYTES), url, prefix: branchRefName, onAuth });
    let branchRef = refs.find(ref => ref.ref === branchRefName);
    if (!branchRef) {
      return currentCommit === ""
        ? { commit: "", changed: false }
        : { commit: "", changed: true, documents: [] };
    }
    if (branchRef.oid === currentCommit) {
      // Currently stored commit is still the tip of the mirrored branch.
      return { commit: currentCommit, changed: false };
    }

    let commit = "";
    if ((await gitdirStats(dir)).exists) {
      // Stale repo checkout already exists in in-memory filesystem.
      commit = await fetchOrRecloneRepo(dir, url, branch, onAuth);
      if (!commit) return { commit: "", changed: true, documents: [] };
    } else {
      // Repo needs to be cloned from scratch.
      await cloneRepo(dir, url, branch, onAuth);
      commit = await resolveRef({ fs, dir, ref: "HEAD" });
    }
    if (!commit) return { commit: "", changed: true, documents: [] };

    let filepaths = await listGitFiles({ fs, dir, ref: commit });
    let documents: ArtifactContextDocument[] = [];
    for (let filepath of filepaths) {
      let { blob } = await readBlob({ fs, dir, oid: commit, filepath });
      let bodyBytes = blob.byteLength;
      if (bodyBytes > MAX_DOCUMENT_BODY_BYTES) {
        logger.warn("skipping oversized mirrored context file", {
          event: "context.file.oversized.skipped",
          filepath,
          bodyBytes,
          maxBodyBytes: MAX_DOCUMENT_BODY_BYTES,
        });
        continue;
      }
      documents.push(artifactContextDocument(filepath, blob));
    }

    return { commit, changed: true, documents };
  } finally {
    await repo.revokeToken(token.id).catch((err) => {
      logger.warn("failed to revoke temporary Artifacts read token for context collection sync", {
        event: "artifacts.read.token.revoke.failed",
        repoName,
        tokenId: token.id,
        error: err,
      });
    });
  }
}
