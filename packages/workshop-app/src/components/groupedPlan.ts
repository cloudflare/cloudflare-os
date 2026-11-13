import { movedKeys } from './movedKeys'

/** Something in the list as it is now: a row, or a copy of one left shrinking out where it was. */
export type PlanItem = {
  id: string
  key: string
  ghost: boolean
  /** The group it is in, or was in when it left. */
  group: string
  /** The room after it now. */
  gap: number
  /** How much of it is there now, 0 to 1. */
  presence: number
  /** A copy on a surface of its own, whose padding shrinks with it. */
  fades: boolean
}

/** Something in the list as it is to be, and where it goes from. */
export type PlannedItem = Omit<PlanItem, 'gap' | 'presence'> & {
  /** What it was, by id; none for a row that has just arrived. */
  was?: string
  /**
   * Stayed in its place among the rest; slid to another place in its group; arrived; left (a copy
   * shrinking out where it was); or came back where its copy was shrinking out, which it grows from.
   */
  change: 'stayed' | 'slid' | 'arrived' | 'left' | 'returned'
  presence: { from: number; to: number }
  gap: { from: number; to: number }
}

export type PlanSpacing = {
  /** The room between the rows of two groups. */
  boundary: number
  /** The room under which two rows' surfaces still meet. */
  touching: number
}

type Draft = Omit<PlannedItem, 'gap'>

/**
 * Plans the list going from `before` to the rows in `after`. Rows that keep their order among each
 * other stay where they are, the room between them opening or closing as their groups change, so
 * groups split and merge around them. A row that moved past others to another group (one starred,
 * one unstarred) instead leaves a copy shrinking out where it was, in the group it was in, and
 * grows in where it is now. One moved within its group slides there over the surface.
 */
export const planList = (
  before: PlanItem[],
  after: Array<{ key: string; group: string }>,
  { boundary, touching }: PlanSpacing,
  ghostId: (key: string) => string,
): PlannedItem[] => {
  const wanted = new Map(after.map(({ key, group }) => [key, group]))
  const live = new Map(before.filter(({ ghost }) => !ghost).map((item) => [item.key, item]))
  // Rows in the same group as before slide to a new place in it, the fewest of them that moved. A
  // row in another group, as groups fold differently, is where it was unless what it is after
  // changed: then it moved to another group, as one starred or unstarred does.
  const oldKeys = [...live.keys()].filter((key) => wanted.has(key))
  const newKeys = after.map(({ key }) => key).filter((key) => live.has(key))
  const keepsGroup = (key: string) => live.get(key)!.group === wanted.get(key)
  const slid = movedKeys(oldKeys.filter(keepsGroup), newKeys.filter(keepsGroup))
  const anchor = (key: string) => keepsGroup(key) && !slid.has(key)
  const anchorBefore = (keys: string[], key: string) => keys.slice(0, keys.indexOf(key)).findLast(anchor)
  const moved = new Set([...slid, ...oldKeys.filter((key) => !keepsGroup(key) && anchorBefore(oldKeys, key) !== anchorBefore(newKeys, key))])
  const jumped = (item: PlanItem) => moved.has(item.key) && !slid.has(item.key)
  const stays = (item: PlanItem) => !item.ghost && wanted.has(item.key) && !moved.has(item.key)

  const sequence: Draft[] = after.map(({ key, group }) => {
    const was = live.get(key)
    if (was && !jumped(was)) {
      return { id: was.id, key, ghost: false, group, fades: false, was: was.id, change: slid.has(key) ? 'slid' : 'stayed', presence: { from: was.presence, to: 1 } }
    }
    return { id: key, key, ghost: false, group, fades: false, change: 'arrived', presence: { from: 0, to: 1 } }
  })

  // The copies, each beside a row of the group it was in, so that it shrinks out of that group.
  before.forEach((item, at) => {
    if (!item.ghost && wanted.has(item.key) && !jumped(item)) return
    const alone = (at === 0 ? Infinity : before[at - 1].gap) >= touching && (at === before.length - 1 ? Infinity : item.gap) >= touching
    const ghost: Draft = {
      id: item.ghost ? item.id : ghostId(item.key),
      key: item.key,
      ghost: true,
      group: item.group,
      fades: item.ghost ? item.fades : alone,
      was: item.id,
      change: 'left',
      presence: { from: item.presence, to: 0 },
    }
    const prior = before.slice(0, at).findLast(stays)
    const next = before.slice(at + 1).find(stays)
    const placeOf = (other: PlanItem) => sequence.findIndex(({ id, ghost: copy }) => !copy && id === other.id)
    let place: number
    if (next && next.group === item.group && prior?.group !== item.group) {
      place = placeOf(next)
    } else {
      place = prior ? placeOf(prior) + 1 : 0
      while (sequence[place]?.ghost) place += 1
    }
    sequence.splice(place, 0, ghost)
  })

  // A row that arrives beside its own copy, as one starred and unstarred again quickly, takes it up.
  for (let at = 0; at < sequence.length; at += 1) {
    const ghost = sequence[at]
    if (!ghost.ghost) continue
    const beside = [at - 1, at + 1].find((other) => sequence[other]?.change === 'arrived' && sequence[other].key === ghost.key)
    if (beside === undefined) continue
    sequence[at] = { ...sequence[beside], was: ghost.was, change: 'returned', presence: { from: ghost.presence.from, to: 1 } }
    sequence.splice(beside, 1)
    if (beside < at) at -= 1
  }

  const count = sequence.length
  const oldAt = new Map(before.map((item, at) => [item.id, at]))
  const oldGap = (item: Draft) => before[oldAt.get(item.was!)!].gap
  // `b` came straight after `a` before, or `a` was last and still is.
  const follows = (a: Draft | undefined, b: Draft | undefined) => {
    if (a?.was === undefined) return false
    const at = oldAt.get(a.was)!
    return b === undefined ? at === before.length - 1 : b.was !== undefined && oldAt.get(b.was) === at + 1
  }
  const from: Array<number | undefined> = sequence.map((item, at) => (follows(item, sequence[at + 1]) ? oldGap(item) : undefined))
  const to: Array<number | undefined> = sequence.map((item, at) => {
    const next = sequence[at + 1]
    if (next === undefined) return 0
    if (item.ghost || next.ghost) return undefined
    return item.group === next.group ? 0 : boundary
  })

  // Rows that arrive take their room from what was between their neighbours, so that what is
  // around them does not move: in the group they are on the side of, they grow in from nothing.
  for (let at = 0; at < count; ) {
    if (sequence[at].was !== undefined) {
      at += 1
      continue
    }
    let end = at
    while (end < count && sequence[end].was === undefined) end += 1
    const prior = sequence[at - 1]
    const next = sequence[end]
    const budget = prior === undefined ? (next === undefined || oldAt.get(next.was!) === 0 ? 0 : undefined) : follows(prior, next) ? oldGap(prior) : undefined
    let remaining = budget
    const gaps = Array.from({ length: end - Math.max(at - 1, 0) }, (_, index) => Math.max(at - 1, 0) + index)
    gaps.forEach((gap, index) => {
      const target = to[gap] ?? 0
      if (remaining === undefined) from[gap] = target
      else if (index === gaps.length - 1) from[gap] = remaining
      else {
        from[gap] = Math.min(remaining, target)
        remaining -= from[gap]
      }
    })
    at = end
  }

  // Around copies, the room left once they have gone is what their neighbours have between them.
  const solid = sequence.flatMap((item, at) => (item.ghost ? [] : [at]))
  const edges = [-1, ...solid, count]
  for (let index = 0; index + 1 < edges.length; index += 1) {
    const a = edges[index]
    const b = edges[index + 1]
    if (b - a <= 1) continue
    const total = a >= 0 && b < count && sequence[a].group !== sequence[b].group ? boundary : 0
    const gaps = Array.from({ length: b - Math.max(a, 0) }, (_, offset) => Math.max(a, 0) + offset)
    // One on its own shrinks to nothing in the middle of the room it leaves; the others go on
    // sharing a surface with what they are beside.
    if (b - a === 2 && sequence[a + 1].fades && a >= 0 && b < count) {
      to[a] = total / 2
      to[a + 1] = total / 2
      continue
    }
    let remaining = total
    gaps.forEach((gap, offset) => {
      if (offset === gaps.length - 1) to[gap] = remaining
      else {
        to[gap] = Math.min(from[gap] ?? 0, remaining)
        remaining -= to[gap]!
      }
    })
  }

  return sequence.map((item, at) => ({ ...item, gap: { from: from[at] ?? to[at]!, to: to[at]! } }))
}
