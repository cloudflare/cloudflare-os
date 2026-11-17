// How much longer than its limit a text may be and still be shown whole: hiding a few words
// behind "more" saves no room.
const SLACK = 20

/**
 * The start of a text that runs past `limit` characters, cut where a word ends, with nothing
 * left dangling at its end; or nothing, for a text that is shown whole.
 */
export const clampText = (text: string, limit: number): string | undefined => {
  if (text.length <= limit + SLACK) return undefined
  const head = text.slice(0, limit + 1)
  const space = head.lastIndexOf(' ')
  // A word longer than the limit is cut where the limit falls.
  const cut = space > 0 ? head.slice(0, space) : head.slice(0, limit)
  return cut.replace(/[\s.,;:!?…–—-]+$/, '')
}
