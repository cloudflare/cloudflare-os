import { describe, expect, it } from 'vitest'
import { SPACING, boundaryOf, layOut, surfaceRuns, type LayoutItem } from './groupedLayout'

const { pad, radius } = SPACING
const ROW = 48
const BOUNDARY = boundaryOf(SPACING)

const surface = (items: LayoutItem[]) => surfaceRuns(items, layOut(items, SPACING).tops, SPACING)
const row = (gap = 0, more: Partial<LayoutItem> = {}): LayoutItem => ({ height: ROW, presence: 1, gap, ...more })
const round = (runs: ReturnType<typeof surface>) => runs.map(({ top, height, topRadius, bottomRadius }) => [top, height, topRadius, bottomRadius].map((value) => Math.round(value * 100) / 100))

describe('layOut', () => {
  it('stacks the rows after the top padding, with the room after each, and pads the bottom', () => {
    expect(layOut([row(), row(BOUNDARY), row()], SPACING)).toEqual({ tops: [pad, pad + ROW, pad + 2 * ROW + BOUNDARY], height: 3 * ROW + BOUNDARY + 2 * pad })
  })

  it('gives one growing in or shrinking out only as much of its height as is there', () => {
    expect(layOut([row(0, { presence: 0.5 }), row()], SPACING).tops).toEqual([pad, pad + ROW / 2])
  })
})

describe('surfaceRuns', () => {
  it('draws each group as one rounded surface, padded around its rows', () => {
    expect(round(surface([row(), row(BOUNDARY), row()]))).toEqual([
      [0, 2 * ROW + 2 * pad, radius, radius],
      [2 * ROW + 2 * pad + SPACING.gap, ROW + 2 * pad, radius, radius],
    ])
  })

  it('keeps two groups one surface until the boundary opening between them is more than padding', () => {
    expect(surface([row(2 * pad), row()])).toHaveLength(1)
    const [upper] = surface([row(2 * pad + SPACING.gap / 4), row()])
    expect(upper.bottomRadius).toBeCloseTo(radius / 2)
  })

  it('leaves a group’s padding where it is as a row at its end shrinks out', () => {
    const before = surface([row(), row(BOUNDARY), row()])
    const going = surface([row(), row(BOUNDARY, { presence: 0 }), row()])
    const gone = surface([row(BOUNDARY), row()])
    expect(round(going)[0][1]).toBeCloseTo(ROW + 2 * pad, 0)
    expect(round(going)).toEqual(round(gone))
    expect(before[0].height - going[0].height).toBeCloseTo(ROW, 0)
  })

  it('shrinks a group of one row shrinking out to nothing, and leaves the next as it would be without it', () => {
    const going = surface([row(0, { presence: 0, fades: true }), row()])
    expect(round(going)).toEqual(round(surface([row()])))
    const half = surface([row(BOUNDARY / 2, { presence: 0.5, fades: true }), row()])
    expect(half).toHaveLength(2)
    expect(half[0].height).toBeCloseTo(ROW / 2 + pad)
  })

  it('has a row growing into a group’s top grow under its padding, which stays', () => {
    for (const presence of [0, 0.1, 0.5, 1]) {
      const [, today] = surface([row(BOUNDARY), row(0, { presence }), row()])
      // The first group's padding, its row and the boundary, less the second group's padding.
      expect(today.top).toBeCloseTo(pad + ROW + BOUNDARY - pad)
      expect(today.topRadius).toBe(radius)
    }
  })
})
