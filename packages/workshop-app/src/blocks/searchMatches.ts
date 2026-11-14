/** Something search can find: what it is called, and words it can be found by besides. */
export type Searchable = { title: string; keywords?: readonly string[] }

const words = (text: string) => text.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

// How well one typed word fits a title: the start of it, the start of a word in it, or anywhere,
// which a single letter is too short to mean anything by.
const fit = (term: string, title: string, titleWords: string[], keywords: string[]) => {
  if (title.startsWith(term)) return 3
  if (titleWords.some((word) => word.startsWith(term))) return 2
  if ((term.length > 1 && title.includes(term)) || keywords.some((word) => word.startsWith(term))) return 1
  return 0
}

/**
 * What fits what was typed, best first: each typed word must be found in the title or keywords, and
 * a title that starts with it, then one with a word that does, beats one that only has it somewhere
 * or in a keyword. Equals keep the order they came in, so a list that is most recent first stays
 * that way. Nothing typed finds everything, as it came.
 */
export const searchMatches = <T extends Searchable>(query: string, entries: readonly T[]): T[] => {
  const terms = words(query)
  if (terms.length === 0) return [...entries]
  return entries
    .map((entry, index) => {
      const title = entry.title.toLocaleLowerCase()
      const titleWords = words(entry.title)
      const keywords = (entry.keywords ?? []).flatMap(words)
      let score = 0
      for (const term of terms) {
        const termFit = fit(term, title, titleWords, keywords)
        if (termFit === 0) return undefined
        score += termFit
      }
      return { entry, index, score }
    })
    .filter((match) => match !== undefined)
    .toSorted((a, b) => b.score - a.score || a.index - b.index)
    .map(({ entry }) => entry)
}
