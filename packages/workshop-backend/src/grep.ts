// File search for the agent's grep tool and the Worktree binding's grep()/structuredGrep(): resolve
// a path argument to the searchable files in a workpiece's overlay-over-base view, pulling missing
// base blobs in one batch, then match lines and render `grep -n` output. Kept apart from
// worktree-session.ts so agent.ts can call it without importing the RpcTarget.

import type { GrepFileError, GrepMatch } from "./worktree-binding";
import type { WorkpieceId } from "@gadgets/workshop-shared/api";
import { MAX_BUFFERED_BLOB_SIZE, type GitOid } from "@gadgets/workshop-shared/gatekeeper";
import { UnreadableContentError, decodeBlobText, type WorkspaceGitCache } from "./git-cache";
import type { BlobReader } from "./git-chunked-blob";
import type { WorktreeTurnAccess } from "./agent";

/**
 * A grep's result: the matching lines, in path order then line order, the files it could not
 * search, and whether it named exactly one file (so output can omit the path prefix, as
 * `grep -n` does). `omitted` counts the matches past a scan's `maxChars`, which it did not keep.
 */
export type GrepScan = {
  matches: GrepMatch[], errors: GrepFileError[], single: boolean, omitted?: number,
};

// One file to search: an overlay path (content in hand) or a base tree entry (blob by oid, in
// the commit it was found in).
type GrepCandidate = { path: string } | { path: string, oid: GitOid, base: string };

/**
 * Greps a path argument's files for `pattern`, in the overlay-over-base view the file tools read:
 * the turn's session content over the workpiece's base commit (a worktree's pin base or accepted
 * commit; a gadget's pin or head; undefined for a gadget with no committed code, whose files all
 * live in the session). Each listed scope is a file or a directory to scan recursively
 * (undefined means the whole tree); unsearchable files -- symlinks, submodules and binary blobs
 * -- and listed paths that don't exist degrade to error entries, except that when *every* listed
 * scope fails, the whole call throws (so a lone bad path is an exception, not an easily-missed
 * one-line result). A file of any size is searched: one over MAX_BUFFERED_BLOB_SIZE is streamed
 * line by line rather than decoded whole (see matchBlob). Missing base blobs are filled in one
 * batched pull across all scopes -- the reason the argument accepts an array -- never a serial
 * walk-and-fetch.
 */
export async function scanWorkpieceForGrep(
    gitCache: Pick<WorkspaceGitCache,
        "pathEntryAtCommit" | "listCommitTreePaths" | "ensureBlobs" | "openBlob">,
    turn: Pick<WorktreeTurnAccess, "getOverlayFiles" | "getRemovedPaths">,
    workpieceId: WorkpieceId, base: string | undefined,
    pathArg: string | string[] | undefined, pattern: RegExp, maxChars = Infinity)
    : Promise<GrepScan> {
  let overlay = turn.getOverlayFiles(workpieceId);
  let removed = turn.getRemovedPaths(workpieceId);

  // Overlapping scopes (["src", "src/util.js"]) resolve to one candidate per path, and one
  // error entry per unsearchable file, no matter how many scopes cover it.
  let scopes = [...new Set(typeof pathArg === "string" ? [pathArg] : pathArg ?? [""])];
  let candidates = new Map<string, GrepCandidate>();
  let errorByFile = new Map<string, string>();
  let failedScopes = new Map<string, string>();
  // Scopes that named a base file directly: unreadable *content* (binary),
  // discovered only after the batched pull, still counts as the scope failing.
  let namedFiles = new Set<string>();
  let single = false;

  for (let scope of scopes) {
    let overlayText = overlay.get(scope);
    if (scope !== "" && overlayText !== undefined) {
      candidates.set(scope, { path: scope });
      namedFiles.add(scope);
      single = typeof pathArg === "string";
      continue;
    }
    // A base entry is only worth asking about when there is a base and the path isn't removed.
    let entry = base !== undefined && !(scope !== "" && removed.has(scope))
        ? await gitCache.pathEntryAtCommit(base, scope) : undefined;
    if (base !== undefined && entry !== undefined && entry.kind !== "dir") {
      if (entry.kind === "symlink" || entry.kind === "submodule") {
        failedScopes.set(scope, `${scope} is a ${entry.kind}`);
        continue;
      }
      candidates.set(scope, { path: scope, oid: entry.oid, base });
      namedFiles.add(scope);
      single = typeof pathArg === "string";
      continue;
    }

    // A directory scope: its base entries (when it exists in the base) plus the overlay's
    // paths under it. A scope with neither doesn't exist -- except the root, which does even
    // when the workpiece has no committed code and no files yet.
    let prefix = scope === "" ? "" : `${scope}/`;
    let found = scope === "";
    if (base !== undefined && entry !== undefined) {
      found = true;
      for (let treeEntry of await gitCache.listCommitTreePaths(
          base, scope === "" ? undefined : scope, { recursive: true })) {
        if (treeEntry.kind === "dir") continue;
        if (treeEntry.kind === "symlink" || treeEntry.kind === "submodule") {
          errorByFile.set(treeEntry.path, `${treeEntry.path} is a ${treeEntry.kind}`);
          continue;
        }
        if (removed.has(treeEntry.path) || overlay.has(treeEntry.path)) continue;
        candidates.set(treeEntry.path, { path: treeEntry.path, oid: treeEntry.oid, base });
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

  // One batched fetch for every missing base blob, across all scopes.
  let oids = new Set<GitOid>();
  for (let candidate of candidates.values()) {
    if ("oid" in candidate) oids.add(candidate.oid);
  }
  await gitCache.ensureBlobs(oids);

  // Each file is matched as it is read, so only one file's text is ever held at a time, and a
  // large blob's not even that. Matches are kept while their `grep -n` lines fit `maxChars`;
  // past that they are only counted, so a broad match over a large file holds no more than the
  // output can show. A file's own are added once it has been searched whole, since it may still
  // prove binary.
  let matches: GrepMatch[] = [];
  let omitted = 0, room = maxChars;
  for (let candidate of [...candidates.values()]
      .toSorted((a, b) => a.path < b.path ? -1 : 1)) {
    try {
      let value = "oid" in candidate ? candidate : overlay.get(candidate.path)!;
      let found = typeof value === "string" ? matchingLines(value, pattern)
          : matchingBlobLines(
              await gitCache.openBlob(value.oid, "base" in value ? value.base : undefined),
              pattern, candidate.path);
      let kept: GrepMatch[] = [], fileOmitted = 0, fileRoom = room;
      let prefix = single ? 0 : candidate.path.length + 1;
      for (let match of found) {
        let length = prefix + `${match.line}:${match.text}`.length + 1;
        if (omitted + fileOmitted > 0 || length > fileRoom) {
          ++fileOmitted;
          continue;
        }
        fileRoom -= length;
        kept.push({ file: candidate.path, ...match });
      }
      matches.push(...kept);
      omitted += fileOmitted;
      room = fileRoom;
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
  return { matches, errors, single, ...omitted > 0 ? { omitted } : {} };
}

/**
 * The lines of `text` matching `pattern`, 1-based, in order. Lines are taken as `grep` takes
 * them, without a trailing CR, so `$` anchors on a CRLF file and the rendered line carries no
 * stray `\r`. The RegExp may have arrived over RPC (structured clone); match against a fresh copy
 * with lastIndex reset per line, so a sticky or global flag can't skip lines.
 */
export function matchLines(text: string, pattern: RegExp): { line: number, text: string }[] {
  return [...matchingLines(text, pattern)];
}

// matchLines, one match at a time.
function* matchingLines(text: string, pattern: RegExp)
    : Generator<{ line: number, text: string }> {
  let lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  let test = lineMatcher(pattern);
  for (let [index, line] of lines.entries()) {
    if (test(line)) yield { line: index + 1, text: line };
  }
}

function lineMatcher(pattern: RegExp): (line: string) => boolean {
  let re = new RegExp(pattern.source, pattern.flags);
  return line => {
    re.lastIndex = 0;
    return re.test(line);
  };
}

/**
 * `matchLines` over a blob's bytes: decoded strictly as text (decodeBlobText) when it is at most
 * MAX_BUFFERED_BLOB_SIZE, else streamed a piece at a time, carrying a partial line across
 * pieces, and decoded leniently (invalid UTF-8 as U+FFFD), so that only the line being matched
 * is ever held. Either way a NUL byte makes the file binary: UnreadableContentError, which
 * callers report as a skip note. (A streamed file with no newline at all is the one case that
 * still holds the file whole, as its single line.)
 */
export function matchBlob(reader: BlobReader, pattern: RegExp, path: string)
    : { line: number, text: string }[] {
  return [...matchingBlobLines(reader, pattern, path)];
}

// matchBlob, one match at a time.
function* matchingBlobLines(reader: BlobReader, pattern: RegExp, path: string)
    : Generator<{ line: number, text: string }> {
  if (reader.size <= MAX_BUFFERED_BLOB_SIZE) {
    yield* matchingLines(decodeBlobText(reader.read(0, reader.size), path), pattern);
    return;
  }
  let test = lineMatcher(pattern);
  let decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  let line = 0;
  let partial = "";
  for (let piece of reader.pieces()) {
    if (piece.includes(0)) throw new UnreadableContentError(`${path} is not a text file`);
    let lines = (partial + decoder.decode(piece, { stream: true })).split("\n");
    partial = lines.pop()!;
    for (let text of lines) {
      ++line;
      if (text.endsWith("\r")) text = text.slice(0, -1);
      if (test(text)) yield { line, text };
    }
  }
  // A final line without a newline keeps a trailing CR, as matchLines keeps it.
  partial += decoder.decode();
  if (partial !== "" && test(partial)) yield { line: line + 1, text: partial };
}

/**
 * Renders a scan's matches the way `grep -n` would -- `path:line:text`, or `line:text` when the
 * scan named a single file -- then one `(skipped: ...)` line per unsearchable file. The whole
 * stays under `maxChars`: matches past it are dropped, then skipped-file lines, and one line each
 * says how many were left out, so the model can narrow the pattern or the path.
 */
export function formatGrep(scan: GrepScan, maxChars: number): string {
  let matches = scan.matches.map(match => scan.single
      ? `${match.line}:${match.text}`
      : `${match.file}:${match.line}:${match.text}`);
  let skipped = scan.errors.map(error => `(skipped: ${error.error})`);

  // Whole lines while they fit. Room for a group's "N more" note is reserved before any of its
  // lines are taken, and for both groups before the first, so the notes fit whenever needed.
  // The scan's omitted matches are always among those not shown.
  let groups: [string[], number, (n: number) => string][] = [
    [matches, scan.omitted ?? 0, n => `(${n} more matches not shown; narrow the pattern or path)`],
    [skipped, 0, n => `(${n} more files skipped)`],
  ];
  let out: string[] = [];
  let left = maxChars;
  for (let [lines, omitted, more] of groups) {
    left -= lines.length + omitted > 0 ? more(lines.length + omitted).length + 1 : 0;
  }
  if (matches.length + (scan.omitted ?? 0) === 0) out.push("(no matches)");
  for (let [lines, omitted, more] of groups) {
    let kept = 0;
    while (kept < lines.length && lines[kept].length + 1 <= left) {
      out.push(lines[kept]);
      left -= lines[kept].length + 1;
      kept++;
    }
    if (kept < lines.length || omitted > 0) {
      out.push(more(lines.length - kept + omitted));
    } else if (lines.length > 0) {
      left += more(lines.length).length + 1;  // note not needed after all
    }
  }
  return out.join("\n");
}
