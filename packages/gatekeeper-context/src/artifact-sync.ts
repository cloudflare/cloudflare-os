import {
  clone, fetch as fetchRemote, listFiles as listGitFiles, listServerRefs, readBlob, resolveRef,
} from "isomorphic-git";
import type { GitHttpResponse, HttpClient } from "isomorphic-git";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import { posix as posixPath } from "node:path";
import { readBytesCapped, ResponseTooLargeError } from "@gadgets/gatekeeper-kit/response-body";
import type { AnsweredWith, CallAnswer, UpstreamRequestInit } from "@gadgets/gatekeeper-kit/upstream";
import {
  MAX_DOCUMENT_BODY_BYTES, contentTypeFromPath, isTextContentType, VENDOR_ID,
} from "./context-types.js";
import { truncateContextDescription } from "./context-storage.js";
import { artifactsCall, contextUpstream } from "./context-upstream.js";
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

// The most bytes a list of refs may hold, which is read whole into memory before it is parsed. A
// ref is a line of a hundred bytes or so, and a list is the branch a collection mirrors or, in
// the advertisement a clone asks for, every ref of its repository: a few MiB hold tens of
// thousands of them.
const MAX_REF_LIST_BYTES = 4 * 1024 * 1024;

class GitTransferTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Repository too large: Git transfer exceeded ${maxBytes} bytes.`);
    this.name = "GitTransferTooLargeError";
  }
}

async function* limitBody(
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, maxBytes: number,
): AsyncIterableIterator<Uint8Array> {
  let seenBytes = 0;
  for await (let chunk of body) {
    seenBytes += chunk.byteLength;
    if (seenBytes > maxBytes) throw new GitTransferTooLargeError(maxBytes);
    yield chunk;
  }
}

// The body of a git request as one piece: isomorphic-git hands it over in chunks, and `fetch`
// sends bytes it can read whole.
async function collectBody(body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<Uint8Array> {
  let chunks: Uint8Array[] = [];
  let size = 0;
  for await (let chunk of body) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  let collected = new Uint8Array(size);
  let offset = 0;
  for (let chunk of chunks) {
    collected.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return collected;
}

// How the answer to a git request that carries no credentials is counted. A remote asks for them
// with a 401, and isomorphic-git, which sends every discovery without them first, then sends it
// with the token: that 401 is a step of a discovery and no failure of the remote. A 401 to a
// request that carries the token is one, and is counted by its status.
const challenge = ({ status }: AnsweredWith): CallAnswer | undefined =>
  status === 401 ? { outcome: "success" } : undefined;

// The options of `contextUpstream` that one kind of git request is sent with.
type GitFetch = Pick<UpstreamRequestInit, "timeoutMs" | "answer">;

/**
 * How a git HTTP client sends its requests through `contextUpstream`: `authorized` is for a
 * request that carries credentials, and `unauthorized` for one that carries none.
 */
export type GitFetches = { authorized: GitFetch; unauthorized: GitFetch };

/**
 * The options a git HTTP client sends its requests with. The two kinds differ in one thing: a 401
 * that answers a request with no credentials is counted as the challenge it is, a success.
 * @param defaults The timeout of every request, where it is not the upstream's.
 * @returns The options of each kind of request.
 */
export function gitFetches(defaults: Pick<UpstreamRequestInit, "timeoutMs"> = {}): GitFetches {
  return { authorized: defaults, unauthorized: { ...defaults, answer: challenge } };
}

// The git requests of a clone and of a fetch, sent through the upstream with no timeout: either
// reads a pack for as long as that takes, and the byte cap is what bounds it.
const sendTransfer = gitFetches({ timeoutMs: null });
// The git requests that list a remote's refs, sent through the upstream with its timeout.
const sendRefs = gitFetches();

// The first packet line of a git request's body, without the line feed that may end it: four
// hexadecimal digits of its length, themselves included, then the line. Undefined for a body that
// begins with none.
function firstPacketLine(body: Uint8Array): string | undefined {
  let decoder = new TextDecoder();
  let digits = decoder.decode(body.subarray(0, 4));
  if (!/^[0-9a-f]{4}$/i.test(digits)) return undefined;
  let length = Number.parseInt(digits, 16);
  if (length <= 4 || length > body.byteLength) return undefined;
  return decoder.decode(body.subarray(4, length)).replace(/\n$/, "");
}

// Whether a git request asks for a list of refs and not for a pack. Two requests do: the
// discovery, a GET that is answered with the advertisement of the remote's refs, and the
// `ls-refs` command of protocol version 2, which the first packet line of a body POSTed to the
// upload endpoint names. Any other request to that endpoint (the `want` lines of a version 1
// negotiation, the `fetch` command of version 2) asks for a pack.
function listsRefs(method: string, url: string, body: Uint8Array | undefined): boolean {
  let operation = contextUpstream.operationOf(method, url);
  if (operation === "git.info-refs") return true;
  return operation === "git.upload-pack" && body !== undefined
    && firstPacketLine(body) === "command=ls-refs";
}

// The answer to a request for a list of refs, with its body read whole where it holds one: a 200
// is the one answer isomorphic-git parses, and the body of any other is left to it as it came.
// isomorphic-git reads a body that fails halfway as one that ended there, and so a list that was
// cut off as a remote with fewer refs, or with none. The list is read here, inside the request,
// so that one cut off fails the request instead.
async function refList(
  response: Response, maxBytes: number,
): Promise<{ response: Response; refs?: Uint8Array }> {
  if (response.status !== 200) return { response };
  let refs = await readBytesCapped(response, maxBytes).catch((err: unknown) => {
    if (err instanceof ResponseTooLargeError) throw new GitTransferTooLargeError(maxBytes);
    throw err;
  });
  // A body may end cleanly short of the list: git ends one with a flush packet, which isomorphic-git
  // does not wait for. A list that does not end so was cut short, and fails the request.
  if (!endsWithFlush(refs)) throw new Error("git ref list ended before its flush packet; the list is incomplete.");
  return { response, refs };
}

// Whether `body` is a run of whole packet lines (git's pkt-line format) whose last is a flush
// packet, `0000`: the end of a list of refs. No list of refs holds another special packet (a
// delimiter, `0001`, or an end of response, `0002`), which isomorphic-git stops reading at.
function endsWithFlush(body: Uint8Array): boolean {
  let decoder = new TextDecoder();
  let at = 0;
  let flushed = false;
  while (at < body.byteLength) {
    if (at + 4 > body.byteLength) return false;
    let digits = decoder.decode(body.subarray(at, at + 4));
    if (!/^[0-9a-f]{4}$/i.test(digits)) return false;
    let length = Number.parseInt(digits, 16);
    if (length === 0) {
      flushed = true;
      at += 4;
      continue;
    }
    if (length < 4 || at + length > body.byteLength) return false;
    flushed = false;
    at += length;
  }
  return flushed;
}

/**
 * The HTTP client isomorphic-git sends a remote's requests with. isomorphic-git's own web client
 * calls the global `fetch`; this one sends the same request through `contextUpstream`, so that
 * every git request is counted, and enforces the transfer size limit on the answer's body. A
 * pack is handed to isomorphic-git as it arrives. A list of refs is read whole first, inside its
 * request: one that is cut off, by the timeout of its attempt or by its connection, fails the
 * request and is counted an error, where isomorphic-git would have read it as a shorter list.
 * @param maxBytes The most bytes one answer's body may hold. A list of refs may hold
 * `MAX_REF_LIST_BYTES` at most.
 * @param send The options each request is sent with, by whether it carries credentials.
 * @returns The client.
 */
export function makeHttp(maxBytes: number, send: GitFetches): HttpClient {
  return {
    async request({ url, method = "GET", headers = {}, body, signal }): Promise<GitHttpResponse> {
      let authorized = Object.keys(headers).some(name => name.toLowerCase() === "authorization");
      let sent = body ? await collectBody(body) : undefined;
      let init: UpstreamRequestInit = {
        ...(authorized ? send.authorized : send.unauthorized), method, headers, body: sent, signal,
      };
      let { response, refs } = listsRefs(method, url, sent)
        ? await contextUpstream.read(url, init,
            answer => refList(answer, Math.min(maxBytes, MAX_REF_LIST_BYTES)))
        : { response: await contextUpstream.request(url, init), refs: undefined };
      return {
        url: response.url,
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        // An answer that has no body is read as one empty chunk.
        body: limitBody(
          refs ? [refs] : response.body ?? [new Uint8Array(await response.arrayBuffer())],
          maxBytes),
      };
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
      http: makeHttp(MAX_GIT_DIR_BYTES, sendTransfer),
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
  let result = await fetchRemote({
    fs,
    http: makeHttp(maxBytes, sendTransfer),
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
  // One read makes a dozen calls or so, counted as one point per kind.
  return contextUpstream.summed(() => obsContext.with({
    operation: "artifacts.repo.read", repoName, branch, dir,
  }, () => readArtifactRepoDocumentsWithContext(
      artifacts, repoName, url, branch, dir, currentCommit)));
}

async function readArtifactRepoDocumentsWithContext(
  artifacts: Artifacts,
  repoName: string,
  url: string,
  branch: string,
  dir: string,
  currentCommit?: string,
): Promise<ArtifactRepoReadResult> {
  let repo = await artifactsCall("repos.get", () => artifacts.get(repoName));
  // Create a temporary read token just for this function call.
  let token = await artifactsCall("tokens.create", () => repo.createToken("read", 3600));

  try {
    let onAuth = () => ({ username: "x-access-token", password: token.plaintext });
    let branchRefName = `refs/heads/${branch}`;
    let refs = await listServerRefs({
      http: makeHttp(MAX_GIT_DIR_BYTES, sendRefs), url, prefix: branchRefName, onAuth,
    });
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
    await artifactsCall("tokens.revoke", () => repo.revokeToken(token.id)).catch((err) => {
      logger.warn("failed to revoke temporary Artifacts read token for context collection sync", {
        event: "artifacts.read.token.revoke.failed",
        repoName,
        tokenId: token.id,
        error: err,
      });
    });
  }
}
