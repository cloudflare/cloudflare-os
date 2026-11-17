/** How a file is indented, as a status line says it and the editor indents with it. */
export type DetectedIndent = { unit: string; label: string }

// Past this many lines, the rest says nothing the first ones did not.
const LOOKED_AT = 2000

/**
 * How a file is indented, from its own lines: with tabs where more of its lines start with a tab
 * than with spaces, else with the step its indentation most often goes in by (2, 4 or 8 spaces).
 * Two spaces for a file that says nothing either way.
 */
export const detectIndent = (text: string): DetectedIndent => {
  let tabs = 0
  let spaced = 0
  const steps = new Map<number, number>()
  let previous = 0
  let looked = 0
  for (const line of text.split('\n')) {
    if (looked++ > LOOKED_AT) break
    if (line.trim() === '') continue
    if (line.startsWith('\t')) {
      tabs += 1
      continue
    }
    const indent = line.length - line.trimStart().length
    if (indent > 0) spaced += 1
    const step = indent - previous
    if (step > 0 && step <= 8) steps.set(step, (steps.get(step) ?? 0) + 1)
    previous = indent
  }
  if (tabs > spaced) return { unit: '\t', label: 'Tabs' }
  let best = 2
  let most = 0
  for (const size of [2, 4, 8]) {
    const count = steps.get(size) ?? 0
    if (count > most) {
      best = size
      most = count
    }
  }
  return { unit: ' '.repeat(best), label: `Spaces: ${best}` }
}
