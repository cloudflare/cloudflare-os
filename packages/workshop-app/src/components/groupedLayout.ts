/** How groups are spaced: a group's padding around its rows, the gap between groups, their corners. */
export type Spacing = { pad: number; gap: number; radius: number }

/** As `ListGroup` draws a group, a gap apart. */
export const SPACING: Spacing = { pad: 6, gap: 12, radius: 24 }

/** The room between the rows of two groups next to each other: one's padding, the gap, the other's. */
export const boundaryOf = ({ pad, gap }: Spacing) => pad + gap + pad

/** One thing in the list, as far as where it goes is concerned. */
export type LayoutItem = {
  /** Its height once all there. */
  height: number
  /** How much of it is there, 0 to 1, as it grows in or shrinks out: that much of its height. */
  presence: number
  /** The room after it, before the next: none within a group, a boundary between two. */
  gap: number
  /** Shrinking out on a surface of its own, whose padding shrinks with it. */
  fades?: boolean
}

/** A stretch of surface: rows whose padding meets share one. */
export type SurfaceRun = { top: number; height: number; topRadius: number; bottomRadius: number }

const clamp = (value: number) => Math.min(1, Math.max(0, value))

/** How much of an item's height is there. */
export const shownHeight = (item: LayoutItem) => item.height * clamp(item.presence)

/** Where each item's top is, after the padding at the top, and how tall the whole list is. */
export const layOut = (items: LayoutItem[], { pad }: Spacing) => {
  let y = pad
  const tops = items.map((item) => {
    const top = y
    y += shownHeight(item) + Math.max(0, item.gap)
    return top
  })
  return { tops, height: items.length === 0 ? 0 : y + pad }
}

/**
 * The surface under items laid out at `tops`. Each item's reaches past it, towards a neighbour, as
 * far as half the room between them, up to the padding: so rows of a group, with no room between,
 * share theirs, and as a boundary opens between two rows, the padding comes first and then the
 * gap, with the corners rounding as it opens. Past one shrinking out on its own, it reaches as far
 * as it would to what is beyond in proportion to how far that one has gone.
 */
export const surfaceRuns = (items: LayoutItem[], tops: number[], { pad, gap, radius }: Spacing): SurfaceRun[] => {
  const extent = (distance: number) => (distance === Infinity ? pad : Math.min(Math.max(0, distance) / 2, pad))
  const round = (visible: number) => (visible === Infinity ? radius : radius * clamp(visible / (gap / 2)))
  const there = (index: number) => (items[index].fades ? clamp(items[index].presence) : 1)
  const gapBefore = (index: number) => (index > 0 ? items[index - 1].gap : Infinity)

  // How far `index` reaches past its edge towards the next in `step`: down (1) or up (-1).
  const reach = (index: number, step: 1 | -1) => {
    let total = 0
    let weight = 1
    let distance = step === 1 ? items[index].gap : gapBefore(index)
    for (let other = index + step; weight > 0; other += step) {
      if (other < 0 || other >= items.length) {
        total += weight * extent(Infinity)
        break
      }
      total += weight * there(other) * extent(distance)
      weight *= 1 - there(other)
      distance += shownHeight(items[other]) + (step === 1 ? items[other].gap : gapBefore(other))
    }
    return total
  }

  const runs: Array<{ top: number; bottom: number; there: number }> = []
  items.forEach((item, index) => {
    const own = there(index)
    const top = tops[index] - reach(index, -1) * own
    const bottom = tops[index] + shownHeight(item) + reach(index, 1) * own
    if (bottom - top < 0.01) return
    const last = runs.at(-1)
    if (last && top <= last.bottom + 0.01) {
      last.top = Math.min(last.top, top)
      last.bottom = Math.max(last.bottom, bottom)
      last.there = Math.max(last.there, own)
    } else {
      runs.push({ top, bottom, there: own })
    }
  })

  // A corner rounds as far as the room past it allows; past a run shrinking out, as far as it would
  // towards what is beyond, in proportion to how far that run has gone.
  const corner = (index: number, step: 1 | -1) => {
    let total = 0
    let weight = 1
    for (let other = index + step; weight > 0; other += step) {
      const run = runs[other]
      if (run === undefined) {
        total += weight * radius
        break
      }
      const visible = step === 1 ? run.top - runs[index].bottom : runs[index].top - run.bottom
      total += weight * run.there * round(visible)
      weight *= 1 - run.there
    }
    return total
  }

  return runs.map((run, index) => ({
    top: run.top,
    height: run.bottom - run.top,
    topRadius: corner(index, -1),
    bottomRadius: corner(index, 1),
  }))
}
