/**
 * The order to show a list in while it is held still, as while it is pointed at: what was shown
 * keeps its place, what has gone is left out, and what is new comes after it, in its own order.
 */
export const heldOrder = (shown: readonly string[], next: readonly string[]): string[] => {
  const present = new Set(next)
  const kept = shown.filter((key) => present.has(key))
  const keptSet = new Set(kept)
  return [...kept, ...next.filter((key) => !keptSet.has(key))]
}

/** Whether two orders are the same. */
export const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((key, index) => key === b[index])
