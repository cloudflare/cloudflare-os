import type { DocumentEdit } from '@gadgets/workshop-shared/gatekeeper'
import { diffWords } from '../change-review/textDiff'
import { changeIdAt, changeLabel } from './changeMarks'

type Range = { start: number; end: number }

/** An edit found where it lands in a tab's Markdown, by offsets into that Markdown. */
export type PlacedEdit = Range & {
  changeId: number
  /** The stretches of `after` drawn as inserted: only the words that differ from `before`. */
  inserted: Range[]
  /** Text the edit takes out, drawn struck at the offset where it stood. */
  removed: { at: number; text: string }[]
  label: string
}

/**
 * Why an edit is not marked in place. Each is shown as a note instead, since guessing where it
 * went could mark text the change never touched.
 * - `not-found`: `after` is not in the Markdown, as when a later edit rewrote it.
 * - `ambiguous`: `after` occurs more than once.
 * - `deletion`: nothing was put in place to locate it by.
 * - `overlap`: a later edit's text overlaps this one's.
 * - `no-text`: it changes no text that could be marked, such as adding a horizontal rule.
 */
export type UnplacedReason = 'not-found' | 'ambiguous' | 'deletion' | 'overlap' | 'no-text'

export type UnplacedEdit = { changeId: number; before: string; after: string; reason: UnplacedReason }

/** Markdown syntax stripped from removed text, which is drawn as plain struck words. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^[ \t]*(?:>[ \t]?)*(?:#{1,6}[ \t]+|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)?/gm, '')
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!|~])/g, '$1')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const occurrences = (text: string, needle: string) => {
  let count = 0
  let first = -1
  for (let at = text.indexOf(needle); at !== -1 && count < 2; at = text.indexOf(needle, at + 1)) {
    if (count === 0) first = at
    count++
  }
  return { count, first }
}

// The whitespace at a run's edges is drawn unmarked: an underline or strike running on through a
// space looks like a dangling line.
const trimmedRange = (text: string, start: number): Range | null => {
  const lead = text.length - text.trimStart().length
  const core = text.trim()
  return core ? { start: start + lead, end: start + lead + core.length } : null
}

function draw(before: string, after: string, start: number): Pick<PlacedEdit, 'inserted' | 'removed'> {
  const segments = before.trim() ? diffWords(before, after) : null
  if (!segments) {
    const whole = trimmedRange(after, start)
    const removed = plainText(before)
    return { inserted: whole ? [whole] : [], removed: removed ? [{ at: start, text: removed }] : [] }
  }
  const inserted: Range[] = []
  const removed: PlacedEdit['removed'] = []
  let offset = start
  for (const segment of segments) {
    if (segment.kind === 'removed') {
      const text = plainText(segment.text)
      if (text) removed.push({ at: offset, text })
      continue
    }
    if (segment.kind === 'added') {
      const range = trimmedRange(segment.text, offset)
      if (range) inserted.push(range)
    }
    offset += segment.text.length
  }
  return { inserted, removed }
}

/**
 * Where an edit's untrimmed `after` starts in `markdown`, found by the one place its context
 * and text occur together, or undefined when that is not exactly once.
 */
function locateByContext(markdown: string, edit: DocumentEdit): number | undefined {
  if (!edit.context) return undefined
  const around = edit.context.before + edit.after + edit.context.after
  if (!around.trim()) return undefined
  const { count, first } = occurrences(markdown, around)
  return count === 1 ? first + edit.context.before.length : undefined
}

/**
 * Finds where each edit landed in `markdown`, by the one place its `after` text occurs. An edit
 * whose text is missing, repeated, empty, or overlapped by a later edit is returned unplaced
 * rather than guessed at.
 */
export function placeEdits(markdown: string, edits: readonly DocumentEdit[], actions: readonly number[]) {
  const candidates: (PlacedEdit | UnplacedEdit)[] = []
  const texts: { before: string; after: string }[] = []
  for (const edit of edits) {
    const changeId = changeIdAt(actions, edit.change)
    if (changeId === undefined) continue
    const after = edit.after.trim()
    const before = edit.before.trim()
    const unplaced = (reason: UnplacedReason): UnplacedEdit => ({ changeId, before, after, reason })
    texts.push({ before, after })
    // The text around it says where it landed: the only way to place a deletion, and a way to
    // place text that occurs more than once.
    const anchored = locateByContext(markdown, edit)
    if (!after) {
      const removed = plainText(before)
      if (anchored === undefined || !removed) {
        candidates.push(unplaced('deletion'))
        continue
      }
      candidates.push({
        changeId, start: anchored, end: anchored, inserted: [], removed: [{ at: anchored, text: removed }],
        label: changeLabel(removed, 'remove'),
      })
      continue
    }
    const { count, first: only } = occurrences(markdown, after)
    const leading = edit.after.length - edit.after.trimStart().length
    const first = anchored !== undefined ? anchored + leading : only
    if (anchored === undefined && count !== 1) {
      candidates.push(unplaced(count === 0 ? 'not-found' : 'ambiguous'))
      continue
    }
    const drawn = draw(before, after, first)
    if (drawn.inserted.every(range => !plainText(markdown.slice(range.start, range.end))) && drawn.removed.length === 0) {
      candidates.push(unplaced('no-text'))
      continue
    }
    candidates.push({
      changeId,
      start: first,
      end: first + after.length,
      ...drawn,
      label: changeLabel(plainText(after) || after),
    })
  }

  // Edits apply in order, so when two overlap the later one's text is what the tab now holds.
  const kept: PlacedEdit[] = []
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i]
    if (!('start' in candidate)) continue
    if (kept.some(other => candidate.start < other.end && other.start < candidate.end)) {
      candidates[i] = { changeId: candidate.changeId, ...texts[i], reason: 'overlap' }
    } else {
      kept.push(candidate)
    }
  }

  return {
    placed: candidates.filter((c): c is PlacedEdit => 'start' in c),
    unplaced: candidates.filter((c): c is UnplacedEdit => 'reason' in c),
  }
}

// --- Drawing placed edits into the rendered Markdown ---------------------------------------------
//
// The edits are located by offsets into the source, and the Markdown is rendered unchanged: a
// rehype plugin reads each text node's source position and wraps the covered parts in <ins>, with
// <del> for removed text. Splicing markers into the source instead could change how it parses
// (a marker before `_` or `#` alters emphasis and headings).

type Position = { start: { offset?: number }; end: { offset?: number } }
type HastText = { type: 'text'; value: string; position?: Position }
type HastElement = {
  type: 'element'
  tagName: string
  properties: Record<string, string | number | boolean>
  children: HastNode[]
  position?: Position
}
type HastNode = HastText | HastElement | { type: string; children?: HastNode[] }
type HastParent = { children?: HastNode[] }

type SourcedText = { node: HastText; parent: HastParent; start: number; end: number; map: number[] }

// Source offset of each character of a text node's value (and one past its end). A text node's
// value is its source less any syntax, escapes and trimmed spaces within its position.
function sourceMap(value: string, source: string, base: number): number[] {
  const at = source === value ? 0 : source.indexOf(value)
  if (at !== -1) return Array.from({ length: value.length + 1 }, (_, i) => base + at + i)
  const map: number[] = []
  let j = 0
  for (let i = 0; i < value.length; i++) {
    let k = j
    while (k < source.length && source[k] !== value[i]) k++
    if (k < source.length) j = k
    map.push(base + j)
    j = Math.min(j + 1, source.length)
  }
  map.push(base + j)
  return map
}

const valueIndex = (text: SourcedText, offset: number) => {
  const i = text.map.findIndex(at => at >= offset)
  return i === -1 ? text.node.value.length : i
}

function collectTexts(tree: HastParent, markdown: string): SourcedText[] {
  const texts: SourcedText[] = []
  const visit = (parent: HastParent) => {
    for (const child of parent.children ?? []) {
      if (child.type === 'text') {
        const node = child as HastText
        const start = node.position?.start.offset
        const end = node.position?.end.offset
        if (start === undefined || end === undefined || !node.value) continue
        texts.push({ node, parent, start, end, map: sourceMap(node.value, markdown.slice(start, end), start) })
      } else if ('children' in child) {
        visit(child as HastParent)
      }
    }
  }
  visit(tree)
  return texts
}

// The text node a removal at `at` is drawn in: the one holding that offset, else the one ending
// there, else the first after it within the edit.
function textForRemoval(texts: SourcedText[], at: number, edit: PlacedEdit) {
  return texts.find(t => t.start <= at && at < t.end)
    ?? texts.findLast(t => t.end === at)
    ?? texts.find(t => t.start > at && t.start < edit.end)
    ?? texts.findLast(t => t.end <= at)
}

const markElement = (tagName: 'ins' | 'del', edit: PlacedEdit, text: string, first: boolean): HastElement => ({
  type: 'element',
  tagName,
  properties: { dataChangeId: edit.changeId, ...(first ? { dataChangeLabel: edit.label } : {}) },
  children: [{ type: 'text', value: text }],
})

/** A rehype plugin drawing `placed` into the tree rendered from the Markdown they were placed in. */
export const rehypeChangeMarks = (markdown: string, placed: readonly PlacedEdit[]) => () => (tree: HastParent) => {
  if (placed.length === 0) return
  const texts = collectTexts(tree, markdown)
  const removals = new Map<SourcedText, { index: number; edit: PlacedEdit; text: string }[]>()
  for (const edit of placed) {
    for (const removed of edit.removed) {
      const text = textForRemoval(texts, removed.at, edit)
      if (!text) continue
      const list = removals.get(text) ?? []
      list.push({ index: Math.min(valueIndex(text, removed.at), text.node.value.length), edit, text: removed.text })
      removals.set(text, list)
    }
  }

  // One element per change is its button, named for the change: the first inserted piece, or the
  // first removed one when the change inserts nothing (removed text vanishes once approved).
  const labelled = new Set<number>()
  const isFirst = (edit: PlacedEdit, tagName: 'ins' | 'del') => {
    if (labelled.has(edit.changeId) || (tagName === 'del' && edit.inserted.length > 0)) return false
    labelled.add(edit.changeId)
    return true
  }

  for (const text of texts) {
    const value = text.node.value
    const spans: { from: number; to: number; edit: PlacedEdit }[] = []
    for (const edit of placed) {
      for (const range of edit.inserted) {
        if (range.end <= text.start || range.start >= text.end) continue
        const from = valueIndex(text, range.start)
        const to = valueIndex(text, range.end)
        if (from < to) spans.push({ from, to, edit })
      }
    }
    const removedHere = removals.get(text) ?? []
    if (spans.length === 0 && removedHere.length === 0) continue
    spans.sort((a, b) => a.from - b.from)

    const cuts = [...new Set([0, value.length, ...spans.flatMap(s => [s.from, s.to]), ...removedHere.map(r => r.index)])]
      .toSorted((a, b) => a - b)
    const out: HastNode[] = []
    cuts.forEach((cut, i) => {
      for (const removed of removedHere.filter(r => r.index === cut)) {
        out.push(markElement('del', removed.edit, removed.text, isFirst(removed.edit, 'del')))
      }
      const next = cuts[i + 1]
      if (next === undefined || next === cut) return
      const piece = value.slice(cut, next)
      const span = spans.find(s => s.from <= cut && next <= s.to)
      out.push(span ? markElement('ins', span.edit, piece, isFirst(span.edit, 'ins')) : { type: 'text', value: piece })
    })
    const siblings = text.parent.children!
    siblings.splice(siblings.indexOf(text.node), 1, ...out)
  }
}
