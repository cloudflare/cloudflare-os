/**
 * The starred workspaces in the order they were kept in (`order`, their ids). One the order does not
 * have yet was starred since, such as on another device, so it comes first, as the latest starred
 * does. Ids the order has that are no longer starred are left out.
 */
export const orderStarred = <T extends { id: string }>(starred: T[], order: string[]): T[] => {
  const place = new Map(order.map((id, index) => [id, index]))
  const unplaced = starred.filter(({ id }) => !place.has(id))
  const placed = starred.filter(({ id }) => place.has(id)).toSorted((a, b) => place.get(a.id)! - place.get(b.id)!)
  return [...unplaced, ...placed]
}
