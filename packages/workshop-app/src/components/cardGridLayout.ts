/** Where a card's place is in the grid, and its size. */
export type Slot = { left: number; top: number; width: number; height: number }

/** An arrow key that moves a card. */
export type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'

/** Whether `key` is an arrow key. */
export const isArrowKey = (key: string): key is ArrowKey => key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown'

const nearer = (a: number, b: number, to: number) => Math.abs(a - to) < Math.abs(b - to)
const middle = (slot: Slot) => ({ x: slot.left + slot.width / 2, y: slot.top + slot.height / 2 })

/**
 * Which of a group's places a card being dragged belongs in, with its middle at (`x`, `y`): on the
 * line whose middle it is nearest, the place whose middle it is nearest. By line first, so that
 * past the end of a last line that is not full it is the last place, not the one above.
 */
export const nearestSlot = (slots: Slot[], x: number, y: number) => {
  const line = slots.reduce((nearest, slot) => (nearer(middle(slot).y, middle(nearest).y, y) ? slot : nearest)).top
  return slots.reduce((nearest, slot, index) => (slot.top === line && (slots[nearest].top !== line || nearer(middle(slot).x, middle(slots[nearest]).x, x)) ? index : nearest), 0)
}

/**
 * Where an arrow key takes the card at `index` among its group's places, which run along lines:
 * left and right to the place before or after, wherever its line that is, and up and down to the
 * line above or below, as nearly over or under where it was as that line has a place. None when
 * there is nowhere further that way.
 */
export const arrowPlace = (slots: Slot[], index: number, key: ArrowKey): number | undefined => {
  if (key === 'ArrowLeft') return index > 0 ? index - 1 : undefined
  if (key === 'ArrowRight') return index < slots.length - 1 ? index + 1 : undefined
  const lines = [...new Set(slots.map(({ top }) => top))].toSorted((a, b) => a - b)
  const line = lines[lines.indexOf(slots[index].top) + (key === 'ArrowUp' ? -1 : 1)]
  if (line === undefined) return undefined
  let nearest: number | undefined
  slots.forEach((slot, other) => {
    if (slot.top !== line) return
    if (nearest === undefined || Math.abs(slot.left - slots[index].left) < Math.abs(slots[nearest].left - slots[index].left)) nearest = other
  })
  return nearest
}
