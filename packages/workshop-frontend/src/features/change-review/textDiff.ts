/** A run of a word diff: text both sides share, or text only the old or only the new one has. */
export type DiffSegment = { kind: 'same' | 'removed' | 'added'; text: string }

// Past this many token pairs between the first and last change, the table outgrows what a chat
// card should spend on drawing it, and the caller shows the two texts apart instead.
const MAX_CELLS = 4_000_000

const tokens = (text: string) => text.split(/(\s+)/).filter(token => token !== '')

const push = (segments: DiffSegment[], kind: DiffSegment['kind'], text: string) => {
  const last = segments.at(-1)
  if (last?.kind === kind) last.text += text
  else segments.push({ kind, text })
}

/**
 * The words `before` and `after` share, and those only one of them has, in reading order: what
 * an edit removes, then what it puts in its place. Whitespace between two changes joins them, so a
 * rewritten phrase reads as one struck run and one new run rather than alternating word by word.
 * Concatenating the `same` and `removed` runs gives back `before` exactly, and the `same` and
 * `added` runs `after`. Null when the texts are too large to compare here.
 */
export function diffWords(before: string, after: string): DiffSegment[] | null {
  const a = tokens(before)
  const b = tokens(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const n = endA - start
  const m = endB - start
  if (n * m > MAX_CELLS) return null

  // lengths[i * (m + 1) + j]: the longest common run of a[start + i..] and b[start + j..].
  const lengths = new Uint32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * (m + 1) + j] = a[start + i] === b[start + j]
        ? lengths[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(lengths[(i + 1) * (m + 1) + j], lengths[i * (m + 1) + j + 1])
    }
  }

  const raw: DiffSegment[] = []
  if (start > 0) push(raw, 'same', a.slice(0, start).join(''))
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      push(raw, 'same', a[start + i])
      i++
      j++
    } else if (j < m && (i === n || lengths[i * (m + 1) + j + 1] >= lengths[(i + 1) * (m + 1) + j])) {
      push(raw, 'added', b[start + j])
      j++
    } else {
      push(raw, 'removed', a[start + i])
      i++
    }
  }
  if (endA < a.length) push(raw, 'same', a.slice(endA).join(''))

  // Fold whitespace-only common runs between changes into the change on each side, then gather
  // each stretch of changes into its removed text followed by its added text.
  const segments: DiffSegment[] = []
  let removed = ''
  let added = ''
  const flush = () => {
    if (removed) push(segments, 'removed', removed)
    if (added) push(segments, 'added', added)
    removed = ''
    added = ''
  }
  raw.forEach((segment, at) => {
    const between = at > 0 && at < raw.length - 1 && raw[at - 1].kind !== 'same' && raw[at + 1].kind !== 'same'
    if (segment.kind === 'same' && between && segment.text.trim() === '') {
      removed += segment.text
      added += segment.text
    } else if (segment.kind === 'removed') {
      removed += segment.text
    } else if (segment.kind === 'added') {
      added += segment.text
    } else {
      flush()
      push(segments, 'same', segment.text)
    }
  })
  flush()
  return segments
}

/** How many words a run holds, for summing what an edit takes out and puts in. */
export const countWords = (text: string) => text.split(/\s+/).filter(word => word !== '').length
