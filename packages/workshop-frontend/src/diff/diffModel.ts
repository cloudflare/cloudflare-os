import { Text } from '@codemirror/state'
import { diff, presentableDiff } from '@codemirror/merge'

// The diff view's model, built in two passes with @codemirror/merge's Myers diff:
//
// 1. A line-level diff (each distinct line mapped to a one-char token, the standard trick)
//    yields Monaco-style changed line ranges: exact line alignment, with unchanged lines never
//    swallowed into a neighboring change. (@codemirror/merge's own Chunk.build was tried
//    first, but its chunking merges changes separated by a single unchanged line, and its
//    word-aligned diff can expand a plain line deletion over an unchanged neighbor. Neither
//    problem applies inside a region pass 1 already fixed, so pass 2 can use it freely.)
// 2. A word-aligned diff (presentableDiff) over each changed region provides the inline
//    highlights and the replacement-vs-unrelated heuristic. Word granularity matters for
//    both: a char-minimal diff highlights the letters two unrelated sentences happen to
//    share, and counting those letters as "preserved" fools the replacement heuristic into
//    pairing lines that should render as a plain deletion plus addition.
//
// Both texts are split on "\n" only, matching the editors' lineSeparator facet, so every
// offset and line number in the model maps exactly onto the editor documents.

export type DiffStatus = 'Added' | 'Deleted' | 'Modified' | 'Unchanged'

export type DiffModel = {
  status: DiffStatus
  additions: number
  deletions: number
  /** Flat list of change runs in document order. Unchanged lines are not modeled. */
  changes: ChangeRun[]
}

/** A single-line column range. 1-based; startCol inclusive, endCol exclusive. */
export type LineSlice = {
  startCol: number
  endCol: number
}

export type ChangeRun = {
  /** Stable identifier across rebuilds while editing in the same session. */
  key: string
  /** 1-based modified-doc line. `modifiedCount === 0` ⇒ pure deletion (anchored before it). */
  modifiedStart: number
  modifiedCount: number
  /** 1-based original-doc line. `originalCount === 0` ⇒ pure addition. */
  originalStart: number
  originalCount: number
  /** Original text for each deleted line, indexed [0, originalCount). */
  deletedText: string[]
  /** Lines paired with an opposite-side line (replacement). Unpaired lines are pure adds/deletes. */
  pairedModifiedLines: Set<number>
  pairedOriginalLines: Set<number>
  /** Word-aligned changed spans by 1-based line number, rendered only on paired lines. */
  inlineModifiedRanges: Map<number, LineSlice[]>
  inlineOriginalRanges: Map<number, LineSlice[]>
}

export type Side = 'modified' | 'original'

/** Max line length (chars) eligible for inline highlighting. */
export const MAX_INLINE_DIFF_LINE_LENGTH = 1024

/** Max deleted lines shown in a single change before truncation kicks in. */
export const MAX_DELETED_ROWS = 120

/** When truncating, how many rows to keep at each end. */
export const DELETED_HEAD_TAIL = 48

/** Minimum non-whitespace preservation on both sides to count as a real replacement. */
const MIN_REPLACEMENT_PRESERVATION = 0.3

// Bound the underlying char diff on pathological inputs, like MergeView's default does.
const DIFF_CONFIG = { scanLimit: 500 }

export type BuildArgs = {
  original: string
  modified: string
  hasOriginal: boolean
  hasModified: boolean
}

export function buildDiffModel({
  original,
  modified,
  hasOriginal,
  hasModified,
}: BuildArgs): DiffModel {
  if (!hasOriginal && hasModified) {
    return {
      status: 'Added',
      additions: lineCountOf(modified),
      deletions: 0,
      changes: [],
    }
  }

  if (hasOriginal && !hasModified) {
    const originalLines = original.length === 0 ? [] : original.split('\n')
    if (originalLines.length === 0) {
      return { status: 'Deleted', additions: 0, deletions: 0, changes: [] }
    }
    return {
      status: 'Deleted',
      additions: 0,
      deletions: originalLines.length,
      changes: [{
        key: 'deleted',
        modifiedStart: 1,
        modifiedCount: 0,
        originalStart: 1,
        originalCount: originalLines.length,
        deletedText: originalLines,
        ...emptyChangeRunFields(),
      }],
    }
  }

  const originalLines = original.split('\n')
  const modifiedLines = modified.split('\n')
  // Text.of(x.split('\n')) round-trips the string exactly (only "\n" separates lines, as in
  // the editors), so Text offsets equal string indices on both sides.
  const originalText = Text.of(originalLines)
  const modifiedText = Text.of(modifiedLines)

  const changes: ChangeRun[] = []
  let additions = 0
  let deletions = 0

  const lineRanges = diffLineRanges(originalLines, modifiedLines)
  for (let i = 0; i < lineRanges.length; i++) {
    const range = lineRanges[i]
    const origStart = range.fromA + 1
    const origCount = range.toA - range.fromA
    const modStart = range.fromB + 1
    const modCount = range.toB - range.fromB
    additions += modCount
    deletions += origCount

    const deletedText = originalLines.slice(range.fromA, range.toA)

    for (const changeRun of buildRangeRuns({
      rangeIndex: i,
      originalText,
      modifiedText,
      origStart,
      origCount,
      modStart,
      modCount,
      deletedText,
    })) {
      changes.push(changeRun)
    }
  }

  return {
    status: additions === 0 && deletions === 0 ? 'Unchanged' : 'Modified',
    additions,
    deletions,
    changes,
  }
}

type LineRange = { fromA: number, toA: number, fromB: number, toB: number }

/**
 * Line-level diff: changed line ranges as 0-based [from, to) line indices, at most one side
 * empty per range. Runs the char-level Myers diff over token strings in which every distinct
 * line is one BMP character.
 */
function diffLineRanges(originalLines: string[], modifiedLines: string[]): LineRange[] {
  const tokens = new Map<string, string>()
  const encodeLine = (line: string): string | null => {
    let token = tokens.get(line)
    if (token === undefined) {
      const id = tokens.size
      // Skip the surrogate range so every token is one UTF-16 unit the diff can't split. The
      // ~60k-distinct-lines capacity is far beyond any real file; past it, fall back to a
      // single prefix/suffix-trimmed range.
      if (id >= 0xd800 + 0x2000) return null
      token = String.fromCharCode(id < 0xd800 ? id : id + 0x800)
      tokens.set(line, token)
    }
    return token
  }
  const encode = (lines: string[]): string | null => {
    let out = ''
    for (const line of lines) {
      const token = encodeLine(line)
      if (token === null) return null
      out += token
    }
    return out
  }

  const encodedA = encode(originalLines)
  const encodedB = encodedA !== null ? encode(modifiedLines) : null
  if (encodedA === null || encodedB === null) {
    return [trimmedLineRange(originalLines, modifiedLines)].filter(
      range => range.toA > range.fromA || range.toB > range.fromB)
  }

  return diff(encodedA, encodedB, DIFF_CONFIG)
    .map(change => ({
      fromA: change.fromA, toA: change.toA, fromB: change.fromB, toB: change.toB,
    }))
}

/** Fallback line range: everything but the common prefix and suffix lines. */
function trimmedLineRange(originalLines: string[], modifiedLines: string[]): LineRange {
  const maxPrefix = Math.min(originalLines.length, modifiedLines.length)
  let prefix = 0
  while (prefix < maxPrefix && originalLines[prefix] === modifiedLines[prefix]) prefix++
  const maxSuffix = maxPrefix - prefix
  let suffix = 0
  while (suffix < maxSuffix &&
    originalLines[originalLines.length - 1 - suffix] ===
      modifiedLines[modifiedLines.length - 1 - suffix]) {
    suffix++
  }
  return {
    fromA: prefix,
    toA: originalLines.length - suffix,
    fromB: prefix,
    toB: modifiedLines.length - suffix,
  }
}

function emptyChangeRunFields() {
  return {
    pairedModifiedLines: new Set<number>(),
    pairedOriginalLines: new Set<number>(),
    inlineModifiedRanges: new Map<number, LineSlice[]>(),
    inlineOriginalRanges: new Map<number, LineSlice[]>(),
  }
}

function lineCountOf(value: string): number {
  return value.length === 0 ? 0 : value.split('\n').length
}

/** Line number at `pos`, tolerating positions one past the end of the document. */
function lineNumberAt(text: Text, pos: number): number {
  return pos > text.length ? text.lines + 1 : text.lineAt(pos).number
}

function changeRunKey(
  modStart: number, origStart: number, modCount: number, origCount: number, suffix: string,
): string {
  return `${modStart}-${origStart}-${modCount}-${origCount}-${suffix}`
}

/** Add per-line column slices covering the span [from, to) of `text` to `map`. */
function addLineSlices(map: Map<number, LineSlice[]>, text: Text, from: number, to: number) {
  const end = Math.min(to, text.length)
  let pos = Math.max(0, from)
  while (pos < end) {
    const line = text.lineAt(pos)
    const sliceEnd = Math.min(end, line.to)
    if (sliceEnd > pos) {
      const slices = map.get(line.number) ?? []
      slices.push({ startCol: pos - line.from + 1, endCol: sliceEnd - line.from + 1 })
      map.set(line.number, slices)
    }
    pos = line.to + 1
  }
}

function addTouchedLines(lines: Set<number>, text: Text, from: number, to: number) {
  const first = lineNumberAt(text, Math.min(from, text.length))
  const last = lineNumberAt(text, Math.min(Math.max(from, to - 1), text.length))
  for (let line = first; line <= last; line++) lines.add(line)
}

/**
 * A real replacement returns one run; unrelated deletion+addition pairs return separate
 * deletion and addition runs.
 */
function buildRangeRuns({
  rangeIndex,
  originalText,
  modifiedText,
  origStart,
  origCount,
  modStart,
  modCount,
  deletedText,
}: {
  rangeIndex: number
  originalText: Text
  modifiedText: Text
  origStart: number
  origCount: number
  modStart: number
  modCount: number
  deletedText: string[]
}): ChangeRun[] {
  if (modCount === 0 || origCount === 0) {
    return [{
      key: changeRunKey(modStart, origStart, modCount, origCount, `${rangeIndex}`),
      modifiedStart: modStart,
      modifiedCount: modCount,
      originalStart: origStart,
      originalCount: origCount,
      deletedText,
      ...emptyChangeRunFields(),
    }]
  }

  // Word-aligned diff over the changed region, in absolute document offsets.
  const origFrom = originalText.line(origStart).from
  const origRegion = originalText.sliceString(origFrom,
    originalText.line(origStart + origCount - 1).to)
  const modFrom = modifiedText.line(modStart).from
  const modRegion = modifiedText.sliceString(modFrom,
    modifiedText.line(modStart + modCount - 1).to)
  const charChanges = presentableDiff(origRegion, modRegion, DIFF_CONFIG)

  const isReplacement =
    preservedFraction(origRegion, charChanges.map(c => [c.fromA, c.toA]))
      >= MIN_REPLACEMENT_PRESERVATION &&
    preservedFraction(modRegion, charChanges.map(c => [c.fromB, c.toB]))
      >= MIN_REPLACEMENT_PRESERVATION

  if (!isReplacement) {
    // Anchor both runs at the same modified line so red renders directly above green.
    return [
      {
        key: changeRunKey(modStart, origStart, modCount, origCount, `${rangeIndex}-d`),
        modifiedStart: modStart,
        modifiedCount: 0,
        originalStart: origStart,
        originalCount: origCount,
        deletedText,
        ...emptyChangeRunFields(),
      },
      {
        key: changeRunKey(modStart, origStart, modCount, origCount, `${rangeIndex}-a`),
        modifiedStart: modStart,
        modifiedCount: modCount,
        // Anchored directly past the deletion run's lines, so the split layout's blank zone
        // (rendered after originalStart - 1, i.e. after the last red line) keeps the sides
        // aligned: [red|blank][blank|green], with the following unchanged lines level again.
        originalStart: origStart + origCount,
        originalCount: 0,
        deletedText: [],
        ...emptyChangeRunFields(),
      },
    ]
  }

  const fields = emptyChangeRunFields()
  for (const change of charChanges) {
    addLineSlices(fields.inlineOriginalRanges, originalText,
      origFrom + change.fromA, origFrom + change.toA)
    addLineSlices(fields.inlineModifiedRanges, modifiedText,
      modFrom + change.fromB, modFrom + change.toB)
    // Lines touched by a two-sided change correspond across the diff: replacements, not pure
    // adds/deletes.
    if (change.toA > change.fromA && change.toB > change.fromB) {
      addTouchedLines(fields.pairedOriginalLines, originalText,
        origFrom + change.fromA, origFrom + change.toA)
      addTouchedLines(fields.pairedModifiedLines, modifiedText,
        modFrom + change.fromB, modFrom + change.toB)
    }
  }
  // Fallback when no change pairs the sides (e.g. a word inserted into an existing line yields
  // a one-sided change): pair positionally so inline highlights still render.
  if (fields.pairedModifiedLines.size === 0) {
    const pairCount = Math.min(modCount, origCount)
    for (let i = 0; i < pairCount; i++) {
      fields.pairedModifiedLines.add(modStart + i)
      fields.pairedOriginalLines.add(origStart + i)
    }
  }

  return [{
    key: changeRunKey(modStart, origStart, modCount, origCount, `${rangeIndex}`),
    modifiedStart: modStart,
    modifiedCount: modCount,
    originalStart: origStart,
    originalCount: origCount,
    deletedText,
    ...fields,
  }]
}

function preservedFraction(text: string, changedSpans: [number, number][]): number {
  const total = countNonWhitespace(text, 0, text.length)
  if (total === 0) return 1
  let changed = 0
  for (const [spanFrom, spanTo] of changedSpans) {
    changed += countNonWhitespace(text, spanFrom, spanTo)
  }
  return Math.max(0, total - changed) / total
}

function countNonWhitespace(text: string, start: number, end: number): number {
  let count = 0
  const lo = Math.max(0, start)
  const hi = Math.min(text.length, end)
  for (let i = lo; i < hi; i++) {
    const c = text.charCodeAt(i)
    // Fast non-regex whitespace check: space, tab, LF, CR, VT, FF.
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 11 && c !== 12) count++
  }
  return count
}
