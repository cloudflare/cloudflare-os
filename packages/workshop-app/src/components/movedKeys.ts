/**
 * The keys that moved from `before` to `after`: the fewest whose leaving out keeps the rest in
 * their order, the others of a longest run still in it. Keys in only one of the two are neither.
 */
export const movedKeys = (before: string[], after: string[]): Set<string> => {
  const was = new Map(before.map((key, index) => [key, index]))
  const kept = after.filter((key) => was.has(key))
  const indices = kept.map((key) => was.get(key)!)

  // The longest increasing run of their old places, by patience sorting: `tails[n]` is where the
  // best run of length n + 1 found so far ends, and `previous` links each to the one before it.
  const tails: number[] = []
  const previous: number[] = []
  indices.forEach((value, at) => {
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (indices[tails[middle]] < value) low = middle + 1
      else high = middle
    }
    previous[at] = low > 0 ? tails[low - 1] : -1
    tails[low] = at
  })

  const stayed = new Set<string>()
  for (let at = tails.at(-1) ?? -1; at >= 0; at = previous[at]) stayed.add(kept[at])
  return new Set(kept.filter((key) => !stayed.has(key)))
}
