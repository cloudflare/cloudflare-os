// File search for the agent's grep tool and the Worktree binding's grep()/structuredGrep(): resolve
// a path argument to the searchable files, match lines, and render `grep -n` output. Worktrees
// scan the overlay-over-base view and pull missing base blobs in one batch; a gadget's files are
// already in hand. Kept apart from worktree-session.ts so agent.ts can call it without importing
// the RpcTarget.

import type { GrepFileError } from "./worktree-binding";
import type { WorkpieceId } from "@gadgets/workshop-shared/api";
import type { GitOid } from "@gadgets/workshop-shared/gatekeeper";
import {
  GitObjectTooLargeError,
  MAX_GIT_OBJECT_SIZE,
  UnreadableContentError,
  type WorkspaceGitCache,
} from "./git-cache";
import type { WorktreeTurnAccess } from "./agent";

/** A searchable file: its path within the workpiece and full text. */
export type GrepFile = { path: string, text: string };

/**
 * The files a grep path argument resolves to, the files it could not search, and whether it named
 * exactly one file (so output can omit the path prefix, as `grep -n` does).
 */
export type GrepScan = { files: GrepFile[], errors: GrepFileError[], single: boolean };

// One file to search: an overlay path (text in hand) or a base tree entry (blob by oid).
type GrepCandidate = { path: string, oid?: GitOid };

/**
 * The gadget counterpart of scanWorktreeForGrep: a gadget's files are all in hand, so the scan is
 * a filter. `path` names a file or a directory (its files, recursively); absent means every file.
 * Throws when `path` names neither, matching the worktree scan's failed-scope error.
 */
export function scanGadgetForGrep(files: ReadonlyMap<string, string>, path?: string): GrepScan {
  let single = path !== undefined && files.has(path);
  let prefix = path === undefined ? "" : `${path}/`;
  let matching = [...files]
      .filter(([file]) => single ? file === path : file.startsWith(prefix))
      .map(([file, text]) => ({ path: file, text }))
      .toSorted((a, b) => a.path < b.path ? -1 : 1);
  if (matching.length === 0 && path !== undefined) {
    throw new Error(`${path}: no such file or directory`);
  }
  return { files: matching, errors: [], single };
}

/**
 * Resolves a grep path argument to the searchable files' text. Each listed scope is a file or a
 * directory to scan recursively in the overlay-over-base view (undefined means the whole tree);
 * unsearchable files -- symlinks, submodules, oversized and binary blobs -- and listed paths that
 * don't exist degrade to error entries, except that when *every* listed scope fails, the whole call
 * throws (so a lone bad path is an exception, not an easily-missed one-line result). Missing base
 * blobs are filled in one batched pull across all scopes -- the reason the argument accepts an
 * array -- never a serial walk-and-fetch; an oversized blob (measured, or omitted by the pull's own
 * filter) drops out of the batch with an error entry rather than failing it.
 */
export async function scanWorktreeForGrep(
    gitCache: WorkspaceGitCache, turn: WorktreeTurnAccess, worktreeId: WorkpieceId, base: string,
    pathArg: string | string[] | undefined): Promise<GrepScan> {
  let overlay = turn.getOverlayFiles(worktreeId);
  let removed = turn.getRemovedPaths(worktreeId);

  // Overlapping scopes (["src", "src/util.js"]) resolve to one candidate per path, and one
  // error entry per unsearchable file, no matter how many scopes cover it.
  let scopes = [...new Set(typeof pathArg === "string" ? [pathArg] : pathArg ?? [""])];
  let candidates = new Map<string, GrepCandidate>();
  let errorByFile = new Map<string, string>();
  let failedScopes = new Map<string, string>();
  // Scopes that named a base file directly: unreadable *content* (oversized/binary),
  // discovered only after the batched pull, still counts as the scope failing.
  let namedFiles = new Set<string>();
  let single = false;

  for (let scope of scopes) {
    let overlayText = overlay.get(scope);
    if (scope !== "" && overlayText !== undefined) {
      candidates.set(scope, { path: scope });
      single = typeof pathArg === "string";
      continue;
    }
    let entry = scope !== "" && removed.has(scope)
        ? undefined : await gitCache.pathEntryAtCommit(base, scope);
    if (entry !== undefined && entry.kind !== "dir") {
      if (entry.kind === "symlink" || entry.kind === "submodule") {
        failedScopes.set(scope, `${scope} is a ${entry.kind}`);
        continue;
      }
      candidates.set(scope, { path: scope, oid: entry.oid });
      namedFiles.add(scope);
      single = typeof pathArg === "string";
      continue;
    }

    // A directory scope: its base entries (when it exists in the base) plus the overlay's
    // paths under it. A scope with neither doesn't exist.
    let prefix = scope === "" ? "" : `${scope}/`;
    let found = false;
    if (entry !== undefined) {
      found = true;
      for (let treeEntry of await gitCache.listCommitTreePaths(
          base, scope === "" ? undefined : scope, { recursive: true })) {
        if (treeEntry.kind === "dir") continue;
        if (treeEntry.kind === "symlink" || treeEntry.kind === "submodule") {
          errorByFile.set(treeEntry.path, `${treeEntry.path} is a ${treeEntry.kind}`);
          continue;
        }
        if (removed.has(treeEntry.path) || overlay.has(treeEntry.path)) continue;
        candidates.set(treeEntry.path, { path: treeEntry.path, oid: treeEntry.oid });
      }
    }
    for (let overlayPath of overlay.keys()) {
      if (prefix === "" || overlayPath.startsWith(prefix)) {
        candidates.set(overlayPath, { path: overlayPath });
        found = true;
      }
    }
    if (!found) failedScopes.set(scope, `${scope}: no such file or directory`);
  }

  // One batched fetch for every missing base blob, across all scopes. Paths with identical
  // content share one blob oid, so each oid maps to every path holding it: an oversized blob
  // then notes each of those files, keeping the one-error-per-skipped-file promise.
  let missing = new Map<GitOid, string[]>();
  for (let candidate of candidates.values()) {
    if (candidate.oid !== undefined && !gitCache.hasLocalObject(candidate.oid)) {
      let missingPaths = missing.get(candidate.oid);
      if (missingPaths === undefined) missing.set(candidate.oid, missingPaths = []);
      missingPaths.push(candidate.path);
    }
  }
  let skipped = new Set<GitOid>();
  while (missing.size > 0) {
    try {
      await gitCache.ensureGitObjects([...missing.keys()], {
        type: "blob",
        commitHistory: { kind: "depth", depth: 1 },
        filterBlobSize: MAX_GIT_OBJECT_SIZE + 1,
      });
      break;
    } catch (err) {
      if (err instanceof GitObjectTooLargeError && missing.has(err.oid)) {
        for (let missingPath of missing.get(err.oid)!) {
          errorByFile.set(missingPath, `${missingPath} is too large to read`);
        }
        skipped.add(err.oid);
        missing.delete(err.oid);
        continue;  // retry the rest of the batch (already-pulled blobs are skipped)
      }
      throw err;
    }
  }

  let files: GrepFile[] = [];
  for (let candidate of [...candidates.values()]
      .toSorted((a, b) => a.path < b.path ? -1 : 1)) {
    if (candidate.oid === undefined) {
      files.push({ path: candidate.path, text: overlay.get(candidate.path)! });
      continue;
    }
    if (skipped.has(candidate.oid)) continue;
    try {
      files.push({
        path: candidate.path,
        text: await gitCache.readTextBlob(candidate.oid, base, candidate.path),
      });
    } catch (err) {
      if (err instanceof UnreadableContentError) {
        errorByFile.set(candidate.path, err.message);
        continue;
      }
      throw err;
    }
  }

  // The all-listed-scopes-failed throw. A directly named file whose content proved unreadable
  // failed its scope too; a scope that resolved (the root always does) succeeded even if it
  // yielded nothing searchable. An empty array lists nothing, so it fails nothing: an empty
  // result.
  for (let scope of namedFiles) {
    let message = errorByFile.get(scope);
    if (message !== undefined) failedScopes.set(scope, message);
  }
  if (scopes.length > 0 && failedScopes.size === scopes.length) {
    throw new Error([...failedScopes.values()].join("; "));
  }
  for (let [file, message] of failedScopes) errorByFile.set(file, message);

  let errors = [...errorByFile]
      .map(([file, message]) => ({ file, error: message }))
      .toSorted((a, b) => a.file < b.file ? -1 : 1);
  return { files, errors, single };
}

/**
 * The lines of `text` matching `pattern`, 1-based, in order. Lines are taken as `grep` takes
 * them, without a trailing CR, so `$` anchors on a CRLF file and the rendered line carries no
 * stray `\r`. The RegExp may have arrived over RPC (structured clone); match against a fresh copy
 * with lastIndex reset per line, so a sticky or global flag can't skip lines.
 */
export function matchLines(text: string, pattern: RegExp): { line: number, text: string }[] {
  let re = new RegExp(pattern.source, pattern.flags);
  let lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  let out: { line: number, text: string }[] = [];
  for (let [index, line] of lines.entries()) {
    re.lastIndex = 0;
    if (re.test(line)) out.push({ line: index + 1, text: line });
  }
  return out;
}

/**
 * Renders a scan's matches the way `grep -n` would -- `path:line:text`, or `line:text` when the
 * scan named a single file -- followed by one `(skipped: ...)` line per unsearchable file.
 */
export function formatGrep(scan: GrepScan, pattern: RegExp): string {
  let out: string[] = [];
  for (let file of scan.files) {
    for (let match of matchLines(file.text, pattern)) {
      out.push(scan.single
          ? `${match.line}:${match.text}`
          : `${file.path}:${match.line}:${match.text}`);
    }
  }
  if (out.length === 0) out.push("(no matches)");
  out.push(...scan.errors.map(error => `(skipped: ${error.error})`));
  return out.join("\n");
}
