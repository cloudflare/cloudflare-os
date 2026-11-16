/**
 * The starred entries in the order they were kept in on this device (`order`, their keys). One the
 * order does not have yet was starred since, such as on another device, so it comes first, as the
 * latest starred does, keeping the order it was given in. Keys the order has that are no longer
 * starred are left out.
 */
export const byStarOrder = <T extends { key: string }>(starred: T[], order: string[]): T[] => {
  const place = new Map(order.map((key, index) => [key, index]))
  const unplaced = starred.filter(({ key }) => !place.has(key))
  const placed = starred.filter(({ key }) => place.has(key)).toSorted((a, b) => place.get(a.key)! - place.get(b.key)!)
  return [...unplaced, ...placed]
}

/**
 * The order with those listed put in another `order`. A key for what is not listed stays, after
 * them: its entry may only not have been read yet, as while the library's index catches up.
 */
export const withStarOrder = (stars: string[], order: string[]): string[] => [...order, ...stars.filter((key) => !order.includes(key))]
