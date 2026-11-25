/**
 * Where each of `keys` goes round a ring, as a share of a turn, given where those on it were
 * (`was`): spaced evenly, those already on it keeping their order and moving as little as they can
 * between them to close a gap or make room, and those new coming in after the rest. Shares are not
 * wrapped to one turn, so that each is eased the short way to where it goes.
 */
export const spaceRing = (was: ReadonlyMap<string, number>, keys: readonly string[]): Map<string, number> => {
  const shareOf = (key: string) => was.get(key) ?? 0
  const kept = keys.filter((key) => was.has(key)).toSorted((a, b) => shareOf(a) - shareOf(b))
  const order = [...kept, ...keys.filter((key) => !was.has(key))]
  const step = 1 / order.length
  const start = kept.length === 0 ? 0 : kept.reduce((sum, key, index) => sum + shareOf(key) - index * step, 0) / kept.length
  return new Map(order.map((key, index) => [key, start + index * step]))
}
