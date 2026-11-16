import { describe, expect, it } from 'vitest'
import { arrowPlace, nearestSlot, type Slot } from './cardGridLayout'

// Five cards, three to a line: 100 wide and 80 tall, 10 apart.
const SLOTS: Slot[] = [0, 1, 2, 3, 4].map((index) => ({ left: (index % 3) * 110, top: Math.floor(index / 3) * 90, width: 100, height: 80 }))

describe('nearestSlot', () => {
  it('gives the place whose middle a dragged card is nearest', () => {
    expect(nearestSlot(SLOTS, 50, 40)).toBe(0)
    // Just over half way to the next place along, and then to the line below.
    expect(nearestSlot(SLOTS, 106, 40)).toBe(1)
    expect(nearestSlot(SLOTS, 160, 86)).toBe(4)
  })

  it('keeps to the last place past the end of a line that is not full', () => {
    expect(nearestSlot(SLOTS, 270, 130)).toBe(4)
  })
})

describe('arrowPlace', () => {
  it('goes a place earlier or later with left and right, from one line to the next', () => {
    expect(arrowPlace(SLOTS, 1, 'ArrowLeft')).toBe(0)
    expect(arrowPlace(SLOTS, 2, 'ArrowRight')).toBe(3)
    expect(arrowPlace(SLOTS, 0, 'ArrowLeft')).toBeUndefined()
    expect(arrowPlace(SLOTS, 4, 'ArrowRight')).toBeUndefined()
  })

  it('goes to the line above or below with up and down, as nearly under as that line has a place', () => {
    expect(arrowPlace(SLOTS, 0, 'ArrowDown')).toBe(3)
    expect(arrowPlace(SLOTS, 4, 'ArrowUp')).toBe(1)
    // Under the third there is nothing: the last of the line below is the nearest.
    expect(arrowPlace(SLOTS, 2, 'ArrowDown')).toBe(4)
    expect(arrowPlace(SLOTS, 1, 'ArrowUp')).toBeUndefined()
    expect(arrowPlace(SLOTS, 3, 'ArrowDown')).toBeUndefined()
  })
})
