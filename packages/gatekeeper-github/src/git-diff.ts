// Pure helpers for simulating pull request diffs from raw git objects. When a pull request's head
// branch has queued pushes, GitHub cannot compute the diff (the pushed commits are not on the
// remote yet), so the gatekeeper computes it locally: a pruning tree-to-tree walk enumerates the
// changed paths, and jsdiff's line-level Myers diff produces hunks in the same shape GitHub's own
// patches are parsed into (`parsePatch` in github.ts).
//
// This module deliberately has no platform imports (in particular no `cloudflare:workers`), so its
// logic runs under the package's Node vitest project. All object reads go through an injected
// `TreeDiffSource`, so the callers decide where bytes come from (the workspace git cache, with
// GitHub's git-data REST API as fallback for the on-remote side).

import { structuredPatch } from "diff";
import type { GitOid } from "@gadgets/workshop-shared/gatekeeper";
import type {
  GitHubPullRequestDiffFile,
  GitHubPullRequestDiffHunk,
  GitHubPullRequestDiffLine,
} from "./types";

/** One entry of a git tree object: mode as written (e.g. `"100644"`, `"40000"`), name, and oid. */
export type GitTreeEntry = {
  mode: string;
  name: string;
  oid: GitOid;
};

/**
 * Where the tree diff reads objects from.
 *
 * `getTree` returns null when the tree object cannot be obtained at all -- the walk then throws
 * `TreeUnavailableError`, and the caller degrades (an enumerable-but-wrong diff would be worse
 * than none). `getBlob` returns `"unavailable"` for a blob that cannot or should not be loaded
 * (missing, or over the size cap); the affected file is then reported with `diffOmitted: true`
 * rather than failing the whole diff -- the same shape GitHub uses for large and binary files.
 */
export type TreeDiffSource = {
  getTree(oid: GitOid): Promise<GitTreeEntry[] | null>;
  getBlob(oid: GitOid): Promise<Uint8Array | "unavailable">;
};

/** Thrown when a tree object needed to enumerate the diff cannot be obtained. */
export class TreeUnavailableError extends Error {
  constructor(oid: GitOid) {
    super(`git tree ${oid} is not available, so the diff cannot be computed`);
  }
}

/**
 * Per-side line cap on a file's changed middle (after trimming the common prefix and suffix)
 * beyond which the minimal diff is not computed and the whole middle is emitted as one
 * remove-then-add block (see diffTextLines).
 */
export const MAX_DIFF_LINES_PER_FILE = 20000;
/** Per-blob byte cap for diffing (either side); larger files are reported with diffOmitted. */
export const MAX_DIFF_BLOB_BYTES = 1024 * 1024;
/** Total bytes of blob content one tree diff may load; further files are reported as omitted. */
export const MAX_DIFF_TOTAL_BYTES = 20 * 1024 * 1024;
/**
 * Myers edit-distance cap (jsdiff's `maxEditLength`). A file whose minimal diff would exceed
 * this many edits is emitted as one whole remove-then-add block instead -- still a correct
 * unified diff, just not a minimal one -- keeping worst-case time and memory bounded.
 */
const MAX_DIFF_EDIT_DISTANCE = 1000;

const FILE_MODE_MASK = 0o170000;
const MODE_DIR = 0o040000;
const MODE_SYMLINK = 0o120000;
const MODE_GITLINK = 0o160000;

/** The structural kind of a tree entry, from its mode. */
export function treeEntryKind(mode: string): "dir" | "symlink" | "gitlink" | "file" {
  switch (parseInt(mode, 8) & FILE_MODE_MASK) {
    case MODE_DIR: return "dir";
    case MODE_SYMLINK: return "symlink";
    case MODE_GITLINK: return "gitlink";
    default: return "file";
  }
}

function hexOid(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Parse a git tree object's payload (as returned by `GitCache.get()` -- no `<type> <size>\0`
 * header): repeated `<mode> <name>\0<20-byte oid>`. Entry names are decoded as strict,
 * byte-exact UTF-8: a name that is not valid UTF-8 fails the parse, and a leading BOM is kept
 * (`ignoreBOM: true`) -- either a lossy decode or BOM stripping could alias two distinct entries.
 */
export function parseGitTreePayload(payload: Uint8Array, oid: GitOid): GitTreeEntry[] {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const entries: GitTreeEntry[] = [];
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    const nul = space === -1 ? -1 : payload.indexOf(0x00, space + 1);
    if (space === -1 || nul === -1 || nul + 21 > payload.length) {
      throw new Error(`git object ${oid} is not a well-formed tree`);
    }
    let mode: string;
    let name: string;
    try {
      mode = decoder.decode(payload.subarray(offset, space));
      name = decoder.decode(payload.subarray(space + 1, nul));
    } catch {
      throw new Error(`git object ${oid} is not a well-formed tree (non-UTF-8 entry name)`);
    }
    if (!/^[0-7]+$/.test(mode)) {
      throw new Error(`git object ${oid} is not a well-formed tree (bad mode ${JSON.stringify(mode)})`);
    }
    entries.push({ mode, name, oid: hexOid(payload.subarray(nul + 1, nul + 21)) });
    offset = nul + 21;
  }
  return entries;
}

/** One changed path found by the tree walk, before any blob content is considered. */
type ChangedEntry = {
  path: string;
  status: "added" | "modified" | "removed";
  oldEntry?: GitTreeEntry;
  newEntry?: GitTreeEntry;
};

async function loadTree(source: TreeDiffSource, oid: GitOid | null): Promise<GitTreeEntry[]> {
  if (oid === null) return [];
  const entries = await source.getTree(oid);
  if (entries === null) throw new TreeUnavailableError(oid);
  return entries;
}

// Recursive pruning walk: subtrees with equal oids are skipped without loading, so the work is
// bounded by the changed portion of the tree rather than the repository size.
async function walkTreeDiff(
  source: TreeDiffSource,
  oldOid: GitOid | null,
  newOid: GitOid | null,
  prefix: string,
  out: ChangedEntry[],
): Promise<void> {
  if (oldOid === newOid) return;
  const oldEntries = new Map((await loadTree(source, oldOid)).map(entry => [entry.name, entry]));
  const newEntries = new Map((await loadTree(source, newOid)).map(entry => [entry.name, entry]));

  const names = [...new Set([...oldEntries.keys(), ...newEntries.keys()])].toSorted();
  for (const name of names) {
    const oldEntry = oldEntries.get(name);
    const newEntry = newEntries.get(name);
    const path = prefix + name;
    const oldKind = oldEntry ? treeEntryKind(oldEntry.mode) : undefined;
    const newKind = newEntry ? treeEntryKind(newEntry.mode) : undefined;
    if (oldEntry && newEntry && oldEntry.oid === newEntry.oid && oldEntry.mode === newEntry.mode) {
      continue;
    }

    // A directory on either side recurses; a dir-vs-file conflict is a remove plus an add.
    if (oldKind === "dir" || newKind === "dir") {
      await walkTreeDiff(
        source,
        oldKind === "dir" ? oldEntry!.oid : null,
        newKind === "dir" ? newEntry!.oid : null,
        `${path}/`,
        out,
      );
      if (oldEntry && oldKind !== "dir") out.push({ path, status: "removed", oldEntry });
      if (newEntry && newKind !== "dir") out.push({ path, status: "added", newEntry });
      continue;
    }

    if (oldEntry && newEntry) {
      out.push({ path, status: "modified", oldEntry, newEntry });
    } else if (newEntry) {
      out.push({ path, status: "added", newEntry });
    } else if (oldEntry) {
      out.push({ path, status: "removed", oldEntry });
    }
  }
}

/**
 * The paths that differ between two trees (either may be null for an empty side). Used for
 * per-commit path filtering; loads no blob content.
 */
export async function changedPathsBetweenTrees(
  source: TreeDiffSource,
  oldTree: GitOid | null,
  newTree: GitOid | null,
): Promise<string[]> {
  const entries: ChangedEntry[] = [];
  await walkTreeDiff(source, oldTree, newTree, "", entries);
  return [...new Set(entries.map(entry => entry.path))];
}

function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/**
 * Diff two trees into the same per-file shape GitHub's compare/PR-files responses normalize to.
 * Gitlinks (submodule pointers), binary files, files over `MAX_DIFF_BLOB_BYTES`, and files whose
 * content is unavailable are reported with `diffOmitted: true` and no hunks; renames are not
 * detected (they appear as a remove plus an add, which GitHub's own rename detection will
 * supersede once the work reaches the remote).
 */
export async function diffGitTrees(
  source: TreeDiffSource,
  oldTree: GitOid | null,
  newTree: GitOid | null,
): Promise<GitHubPullRequestDiffFile[]> {
  const entries: ChangedEntry[] = [];
  await walkTreeDiff(source, oldTree, newTree, "", entries);

  const files: GitHubPullRequestDiffFile[] = [];
  let budget = MAX_DIFF_TOTAL_BYTES;
  for (const entry of entries) {
    const omitted: GitHubPullRequestDiffFile = {
      path: entry.path,
      status: entry.status,
      additions: 0,
      deletions: 0,
      diffOmitted: true,
      hunks: [],
    };

    // Submodule pointers have no blob content; a same-oid entry differs only in mode. Both are
    // reported without a patch, like GitHub does.
    const oldKind = entry.oldEntry ? treeEntryKind(entry.oldEntry.mode) : undefined;
    const newKind = entry.newEntry ? treeEntryKind(entry.newEntry.mode) : undefined;
    if (oldKind === "gitlink" || newKind === "gitlink" ||
        (entry.oldEntry && entry.newEntry && entry.oldEntry.oid === entry.newEntry.oid)) {
      files.push(omitted);
      continue;
    }

    const oldContent = entry.oldEntry ? await source.getBlob(entry.oldEntry.oid) : new Uint8Array(0);
    const newContent = entry.newEntry ? await source.getBlob(entry.newEntry.oid) : new Uint8Array(0);
    if (oldContent === "unavailable" || newContent === "unavailable" ||
        oldContent.byteLength > MAX_DIFF_BLOB_BYTES || newContent.byteLength > MAX_DIFF_BLOB_BYTES ||
        oldContent.byteLength + newContent.byteLength > budget ||
        isBinary(oldContent) || isBinary(newContent)) {
      files.push(omitted);
      continue;
    }
    budget -= oldContent.byteLength + newContent.byteLength;

    // Keep a leading BOM (`ignoreBOM: true`) so a BOM-only change still produces a visible diff.
    const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
    const { hunks, additions, deletions } =
      diffTextLines(decoder.decode(oldContent), decoder.decode(newContent));
    files.push({
      path: entry.path,
      status: entry.status,
      additions,
      deletions,
      diffOmitted: false,
      hunks,
    });
  }
  return files;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The marker line git and GitHub emit after a final line missing its newline. */
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

/** git's default unified-diff context. */
const HUNK_CONTEXT_LINES = 3;

/**
 * A hunk's `@@` header in git's own format: the count is omitted when it is 1, and a zero-count
 * side names the line it attaches after (git's `-l,0` / `+m,0` convention, 0 at the start of
 * the file) -- which is how GitHub's patches spell it, so `parsePatch` sees one grammar.
 */
function hunkHeader(oldStart: number, oldCount: number, newStart: number, newCount: number)
    : string {
  return `@@ -${oldStart}${oldCount === 1 ? "" : `,${oldCount}`}` +
    ` +${newStart}${newCount === 1 ? "" : `,${newCount}`} @@`;
}

/**
 * Unified-diff a file's text at line granularity: jsdiff's `structuredPatch` (a Myers diff, the
 * same engine behind workshop-backend's formatUnifiedDiff) with git's default 3 lines of
 * context, converted to the same shape `parsePatch` produces from GitHub's own patches --
 * including git's `\ No newline at end of file` marker after a final line missing its newline
 * (a numberless context line, exactly as `parsePatch` preserves it), which jsdiff emits
 * natively.
 *
 * Minimality is bounded two ways, both degrading to one whole remove-then-add block (still a
 * correct unified diff, just not a minimal one): a diff needing more than
 * `MAX_DIFF_EDIT_DISTANCE` edits is cut off by jsdiff's `maxEditLength`, and a middle section
 * (after trimming the common prefix and suffix) of more than `MAX_DIFF_LINES_PER_FILE` lines
 * per side skips the Myers run entirely -- together they cap the worst case at
 * O(lines x edits) with both factors bounded, while a huge file with a small change still
 * diffs minimally.
 */
export function diffTextLines(oldText: string, newText: string): {
  hunks: GitHubPullRequestDiffHunk[];
  additions: number;
  deletions: number;
} {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const oldNoEol = oldText.length > 0 && !oldText.endsWith("\n");
  const newNoEol = newText.length > 0 && !newText.endsWith("\n");

  // Trim the common prefix and suffix to find the changed middle. jsdiff re-derives this
  // itself; the trim here sizes the middle for the line-cap guard and scopes the fallback. The
  // trim is EOF-newline aware at the very last pair -- git treats the terminator as part of the
  // line, so `"a"` -> `"a\n"` is a real change the final lines must stay in the middle for --
  // which only the prefix's last possible step and the suffix's first can hit.
  const eolMismatch = oldNoEol !== newNoEol;
  let start = 0;
  while (start < oldLines.length && start < newLines.length &&
         oldLines[start] === newLines[start]) {
    if (eolMismatch && start === oldLines.length - 1 && start === newLines.length - 1) break;
    start++;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    if (eolMismatch && oldEnd === oldLines.length && newEnd === newLines.length) break;
    oldEnd--;
    newEnd--;
  }

  const patch = oldEnd - start <= MAX_DIFF_LINES_PER_FILE &&
      newEnd - start <= MAX_DIFF_LINES_PER_FILE
    ? structuredPatch("a", "b", oldText, newText, undefined, undefined,
                      { context: HUNK_CONTEXT_LINES, maxEditLength: MAX_DIFF_EDIT_DISTANCE })
    : undefined;
  if (patch === undefined) {
    return wholesaleDiff(oldLines, newLines, oldNoEol, newNoEol, start, oldEnd, newEnd);
  }

  // Convert jsdiff's hunks (prefixed line strings, one-based starts and counts) to numbered
  // lines, walking each hunk exactly as `parsePatch` walks a GitHub patch. One convention
  // differs: jsdiff reports a zero-count side's start as one *past* the attach-after line,
  // where git writes the attach-after line itself, so those starts shift down by one (the
  // shift never affects numbering -- a zero-count side numbers no lines).
  const hunks: GitHubPullRequestDiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  for (const hunk of patch.hunks) {
    const oldStart = hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart;
    const newStart = hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart;
    let oldLine = oldStart;
    let newLine = newStart;
    const lines: GitHubPullRequestDiffLine[] = [];
    for (const raw of hunk.lines) {
      if (raw.startsWith("+")) {
        lines.push({ kind: "added", text: raw.slice(1), newLineNumber: newLine++ });
        additions++;
      } else if (raw.startsWith("-")) {
        lines.push({ kind: "removed", text: raw.slice(1), oldLineNumber: oldLine++ });
        deletions++;
      } else if (raw.startsWith("\\")) {
        lines.push({ kind: "context", text: raw });
      } else {
        lines.push({ kind: "context", text: raw.slice(1),
                     oldLineNumber: oldLine++, newLineNumber: newLine++ });
      }
    }
    hunks.push({ header: hunkHeader(oldStart, hunk.oldLines, newStart, hunk.newLines), lines });
  }
  return { hunks, additions, deletions };
}

/**
 * The bounded fallback: one hunk removing the changed middle's every old line and adding its
 * every new one, padded with up to `HUNK_CONTEXT_LINES` of the trimmed common prefix/suffix
 * (only the middle, so a pathological change in a huge file cannot balloon into re-emitting
 * the whole file). The EOF-newline markers are placed by hand here -- after the removed block
 * when the old side's unterminated last line is in it, after the added block likewise, and
 * after a trailing context line ending both sides -- since jsdiff never sees this path.
 */
function wholesaleDiff(
  oldLines: string[], newLines: string[], oldNoEol: boolean, newNoEol: boolean,
  start: number, oldEnd: number, newEnd: number,
): { hunks: GitHubPullRequestDiffHunk[]; additions: number; deletions: number } {
  const marker: GitHubPullRequestDiffLine = { kind: "context", text: NO_NEWLINE_MARKER };
  const contextBefore = Math.min(HUNK_CONTEXT_LINES, start);
  const contextAfter = Math.min(HUNK_CONTEXT_LINES, oldLines.length - oldEnd);
  const lines: GitHubPullRequestDiffLine[] = [];
  for (let i = start - contextBefore; i < start; i++) {
    lines.push({ kind: "context", text: oldLines[i], oldLineNumber: i + 1, newLineNumber: i + 1 });
  }
  for (let i = start; i < oldEnd; i++) {
    lines.push({ kind: "removed", text: oldLines[i], oldLineNumber: i + 1 });
  }
  if (oldNoEol && oldEnd === oldLines.length && oldEnd > start) lines.push(marker);
  for (let i = start; i < newEnd; i++) {
    lines.push({ kind: "added", text: newLines[i], newLineNumber: i + 1 });
  }
  if (newNoEol && newEnd === newLines.length && newEnd > start) lines.push(marker);
  for (let i = 0; i < contextAfter; i++) {
    lines.push({ kind: "context", text: oldLines[oldEnd + i],
                 oldLineNumber: oldEnd + i + 1, newLineNumber: newEnd + i + 1 });
  }
  if (contextAfter > 0 && oldEnd + contextAfter === oldLines.length && oldNoEol && newNoEol) {
    lines.push(marker);
  }

  const oldCount = contextBefore + (oldEnd - start) + contextAfter;
  const newCount = contextBefore + (newEnd - start) + contextAfter;
  const header = hunkHeader(
    oldCount === 0 ? start : start - contextBefore + 1, oldCount,
    newCount === 0 ? start : start - contextBefore + 1, newCount);
  return { hunks: [{ header, lines }], additions: newEnd - start, deletions: oldEnd - start };
}
