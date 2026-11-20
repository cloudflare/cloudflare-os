import type { ArrangedGroup } from './listView'

// What is listed before the letters: names that start with a digit or a symbol, or are empty.
const OTHER = '#'

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

/** The letter a name is listed under, without case or accents. */
const initialOf = (name: string) => {
  const first = name.trim().normalize('NFD').slice(0, 1).toUpperCase()
  return /\p{L}/u.test(first) ? first : OTHER
}

/**
 * `items` by name, A to Z, under the letters they start with, as fine as there are enough of them
 * for: a letter with `enough` names is a group of its own ("B"), and one with fewer is gathered up
 * with the letters after it ("C – F"), as `groupByTime` does with quiet days. Names that start with
 * no letter come first.
 */
export const groupByName = <T>(items: T[], nameOf: (item: T) => string, enough = 2): ArrangedGroup<T>[] => {
  const letters = new Map<string, T[]>()
  for (const item of items.toSorted((a, b) => collator.compare(nameOf(a), nameOf(b)))) {
    const initial = initialOf(nameOf(item))
    letters.set(initial, [...(letters.get(initial) ?? []), item])
  }
  const inOrder = [...letters].toSorted(([a], [b]) => (a === OTHER ? -1 : b === OTHER ? 1 : collator.compare(a, b)))

  const groups: ArrangedGroup<T>[] = []
  let pending: Array<[string, T[]]> = []
  const close = () => {
    const first = pending[0][0]
    const last = pending.at(-1)![0]
    groups.push({
      key: `${first}-${last}`,
      label: first === last ? first : `${first} – ${last}`,
      entries: pending.flatMap(([, within]) => within.map((value) => ({ value }))),
    })
    pending = []
  }
  for (const letter of inOrder) {
    pending.push(letter)
    if (pending.reduce((count, [, within]) => count + within.length, 0) >= enough) close()
  }
  // What is left is the last, and stays apart rather than blur the stretch before it.
  if (pending.length > 0) close()
  return groups
}
