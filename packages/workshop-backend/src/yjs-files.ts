// Helpers for moving plain file maps in and out of chat code docs.
//
// A chat's code doc holds one root `Y.Map<Y.Text>` per gadget (file name -> file body; see
// WorkpieceSummary.filesRoot). The commit-backed code flow constantly crosses between that
// representation and the plain `path -> text` maps the git object store speaks (git-store.ts):
// flattening a root to commit it, and writing merged content back into a live doc.

import * as Y from "yjs";
import onp from "diff3/onp.js";
import { splitLines } from "./git-store";

/** Read all files of one root map of a chat code doc as a plain `name -> text` map. */
export function readDocFiles(doc: Y.Doc, rootName: string): Map<string, string> {
  let files = new Map<string, string>();
  for (let [name, text] of doc.getMap<Y.Text>(rootName)) {
    files.set(name, text.toString());
  }
  return files;
}

/**
 * Replace a Y.Text's content with `content` as a minimal set of edits: a line-level diff finds
 * the changed regions, and each is replaced individually (further trimmed to the changed
 * characters within it). It matters that this is *not* a whole-text rewrite -- nor a single
 * whole-middle replacement between the first and last change: updates built this way stay
 * proportional to the change, and a concurrent live editor's edits in the *unchanged* regions
 * keep their anchors instead of being orphaned by deleting and re-inserting text around them.
 *
 * Indices are UTF-16 code units (Y.Text's own addressing), but the edit boundaries never split a
 * surrogate pair: Yjs encodes update payloads as UTF-8, under which a lone surrogate becomes
 * U+FFFD, so a mid-pair split would make remote replicas decode different content than the local
 * doc holds. (Hunk boundaries fall on line boundaries, which cannot split a pair; the
 * within-hunk character trim checks explicitly.)
 */
export function applyTextEdit(text: Y.Text, content: string): void {
  let current = text.toString();
  if (current === content) return;

  let currentLines = splitLines(current);
  let contentLines = splitLines(content);

  // Trim common whole lines from both ends so the diff below only sees the changed region.
  // (The bounds also keep the trims from overlapping when one side is a prefix of the other.)
  let maxTrim = Math.min(currentLines.length, contentLines.length);
  let start = 0;
  while (start < maxTrim && currentLines[start] === contentLines[start]) ++start;
  let maxEnd = maxTrim - start;
  let end = 0;
  while (end < maxEnd &&
         currentLines[currentLines.length - 1 - end] ===
         contentLines[contentLines.length - 1 - end]) {
    ++end;
  }

  let hunks = diffLines(
      currentLines, start, currentLines.length - end,
      contentLines, start, contentLines.length - end);

  // Apply hunks back to front, so each edit's offsets are unaffected by the edits after it.
  // Offsets are prefix sums of the current text's line lengths.
  let offsets: number[] = [0];
  for (let i = 0; i < currentLines.length; i++) {
    offsets.push(offsets[i] + currentLines[i].length);
  }
  for (let hunk of hunks.toReversed()) {
    let oldText = currentLines.slice(hunk.aStart, hunk.aEnd).join("");
    let newText = contentLines.slice(hunk.bStart, hunk.bEnd).join("");
    replaceSpan(text, offsets[hunk.aStart], oldText, newText);
  }
}

// One contiguous changed region: replace `current` lines [aStart, aEnd) with `content` lines
// [bStart, bEnd). Line indices; ends exclusive; either side may be empty (pure insert/delete).
type Hunk = {aStart: number, aEnd: number, bStart: number, bEnd: number};

// Region-size bound on running the diff engine. Its worst case (a complete rewrite) is
// quadratic in both time and path-node allocations, so a huge all-changed region falls back to
// one hunk covering the whole region instead -- always correct, just less minimal. Edits
// between revisions of a source file are far smaller in practice.
const MAX_DIFF_LINES = 20_000;

// Diff a[aLo..aHi) against b[bLo..bHi) into hunks (in ascending order). The diff itself is
// delegated to the same O(NP) engine diff3Merge uses for threeWayMerge (git-store.ts) -- an
// unexported but stable module of the diff3 package, imported directly (see diff3.d.ts;
// TODO: switch to jsdiff if depending on it ever becomes a problem). The engine returns a flat
// edit script -- one entry per line, marked delete/common/add, in order -- which folds into
// hunks below: each maximal run of non-common entries replaces that run's deleted lines with
// its added lines, and a common line closes the run.
function diffLines(a: string[], aLo: number, aHi: number,
                   b: string[], bLo: number, bHi: number): Hunk[] {
  let n = aHi - aLo;
  let m = bHi - bLo;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0 || n + m > MAX_DIFF_LINES) {
    // Pure insertion or deletion (no diff needed), or too large to diff (see MAX_DIFF_LINES).
    return [{aStart: aLo, aEnd: aHi, bStart: bLo, bEnd: bHi}];
  }

  let engine = onp(a.slice(aLo, aHi), b.slice(bLo, bHi));
  engine.compose();

  let hunks: Hunk[] = [];
  let aIdx = aLo;
  let bIdx = bLo;
  for (let {t} of engine.getses()) {
    if (t === engine.SES_COMMON) {
      ++aIdx;
      ++bIdx;
      continue;
    }
    let hunk = hunks[hunks.length - 1];
    if (!hunk || hunk.aEnd !== aIdx || hunk.bEnd !== bIdx) {
      hunk = {aStart: aIdx, aEnd: aIdx, bStart: bIdx, bEnd: bIdx};
      hunks.push(hunk);
    }
    if (t === engine.SES_DELETE) hunk.aEnd = ++aIdx;
    else hunk.bEnd = ++bIdx;
  }
  return hunks;
}

// Replace the text at [start, start + oldText.length) -- known to currently be `oldText` --
// with `newText`, trimming the common prefix and suffix characters first so the edit covers
// only what changed within the hunk. The trim boundaries never split a surrogate pair (see
// applyTextEdit).
function replaceSpan(text: Y.Text, start: number, oldText: string, newText: string): void {
  let maxPrefix = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) ++prefix;
  // Don't end the retained prefix between a surrogate pair's halves. (The characters at
  // prefix-1 are common to both strings, so one check covers both.)
  if (prefix > 0 && isHighSurrogate(oldText.charCodeAt(prefix - 1))) --prefix;

  let maxSuffix = maxPrefix - prefix;
  let suffix = 0;
  while (suffix < maxSuffix &&
         oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) {
    ++suffix;
  }
  // Likewise, don't start the retained suffix on the low half of a pair.
  if (suffix > 0 && isLowSurrogate(oldText.charCodeAt(oldText.length - suffix))) --suffix;

  let deleteLength = oldText.length - prefix - suffix;
  if (deleteLength > 0) text.delete(start + prefix, deleteLength);
  let inserted = newText.slice(prefix, newText.length - suffix);
  if (inserted) text.insert(start + prefix, inserted);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Make one root map of a chat code doc match `files`, editing in place: files absent from the
 * map are deleted, new ones inserted, and changed ones rewritten via `applyTextEdit`. Runs in a
 * single transaction so observers (and the doc's `updateV2` event) see one atomic update.
 */
export function writeDocFiles(
    doc: Y.Doc, rootName: string, files: ReadonlyMap<string, string>): void {
  let root = doc.getMap<Y.Text>(rootName);
  doc.transact(() => {
    // Snapshot the key list before mutating the map being iterated.
    for (let name of Array.from(root.keys())) {
      if (!files.has(name)) root.delete(name);
    }
    for (let [name, content] of files) {
      let text = root.get(name);
      if (text === undefined) {
        root.set(name, new Y.Text(content));
      } else {
        applyTextEdit(text, content);
      }
    }
  });
}
