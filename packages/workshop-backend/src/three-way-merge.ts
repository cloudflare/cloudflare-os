// Three-way merging of flattened `path -> text` file maps, the merge behind updating a chat from
// mainline and applying a blueprint's release to a gadget. Pure computation: reading the three
// sides out of the git store (git-cache.ts) and committing the result is the caller's.

import diff3Merge from "diff3";

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
 * nonsense) and a conventional git merge (which stops at a both-sides-added conflict rather than
 * marking it). The common ancestor is always explicitly known in our workflow -- the chat's last
 * merged commit -- so no merge-base discovery is needed.
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

/** Compares two flattened file maps for identical content. */
export function filesEqual(
    a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (let [name, content] of a) {
    if (b.get(name) !== content) return false;
  }
  return true;
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
// marker starts its own line.
function withFinalNewline(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

function mergeText(base: string, ours: string, theirs: string, labels: MergeLabels):
    { clean: boolean, text: string } {
  // diff3 operates on arrays of lines; splitLines keeps each line's terminator, so join("")
  // reassembles losslessly.
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
