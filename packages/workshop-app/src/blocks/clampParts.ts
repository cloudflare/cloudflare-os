import { clampText, runsLong } from '@/components/clampText'

/** A stretch of a message: its words, or something that reads as one thing, such as a chip. */
type Part = { type: string; text?: string }

/**
 * The start of a message in parts that runs past `limit` characters, as `clampText` cuts a text:
 * the parts up to there, where the text it falls in is cut where a word ends, and what it does
 * not fall in, such as a chip, is kept whole or left out with the rest. Nothing, for a message
 * that is shown whole. `lengthOf` is how many characters a part that is not words reads as.
 */
export const clampParts = <P extends Part>(parts: readonly P[], limit: number, lengthOf: (part: P) => number): P[] | undefined => {
  const length = (part: P) => (part.type === 'text' ? part.text?.length ?? 0 : lengthOf(part))
  const total = parts.reduce((sum, part) => sum + length(part), 0)
  if (!runsLong(total, limit)) return undefined
  const kept: P[] = []
  let left = limit
  for (const part of parts) {
    if (length(part) <= left) {
      kept.push(part)
      left -= length(part)
      continue
    }
    if (part.type === 'text' && left > 0) kept.push({ ...part, text: clampText(part.text ?? '', left) ?? part.text })
    break
  }
  // Nothing dangling at its end, where the cut fell just after a word.
  const last = kept.at(-1)
  if (last?.type === 'text') kept[kept.length - 1] = { ...last, text: last.text?.replace(/[\s.,;:!?…–—-]+$/, '') }
  return kept
}
